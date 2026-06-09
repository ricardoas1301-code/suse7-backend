// ======================================================================
// Saúde da conexão marketplace (ML) — backend como fonte de verdade para cards UX.
// Não expõe tokens; só metadados agregados.
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { ML_ALL_ACCOUNT_SYNC_JOB_TYPES } from "./createMlInitialSyncJobs.js";

const ACCESS_SKEW_MS = 60 * 1000;

/** @typedef {"connected"|"syncing"|"disconnected"|"token_expired"|"refresh_failed"|"auth_required"|"unknown"} MlConnectionHealthCode */

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 */
function isPostgrestMissingColumnError(error) {
  const c = String(error?.code ?? "");
  const m = String(error?.message ?? "").toLowerCase();
  return c === "42703" || m.includes("column") || m.includes("does not exist");
}

function probeFromTokenRow(data) {
  const hasRefresh = data.refresh_token != null && String(data.refresh_token).trim() !== "";
  return {
    present: true,
    expires_at: data.expires_at != null ? String(data.expires_at) : null,
    has_refresh: hasRefresh,
    token_account_mismatch: false,
    resolved_via: /** @type {"marketplace_account_id" | "ml_user_id" | null} */ (null),
  };
}

/**
 * Token ML para um vendedor específico (multi-conta).
 * Quando `marketplaceAccountId` é informado, resolve primeiro por essa coluna e valida
 * `ml_user_id` === `external_seller_id` da conta; evita falso "sem token" quando só existe
 * token da outra conta ML do mesmo usuário.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {string | null | undefined} mlUserId — external_seller_id / ml_user_id no banco
 * @param {string | null | undefined} [marketplaceAccountId] — marketplace_accounts.id (UUID)
 */
export async function fetchMlTokenProbeForMlSeller(supabase, userId, marketplace, mlUserId, marketplaceAccountId) {
  const mp = marketplace && String(marketplace).trim() !== "" ? String(marketplace).trim() : ML_MARKETPLACE_SLUG;
  const ext =
    mlUserId != null && String(mlUserId).trim() !== "" ? String(mlUserId).trim().replace(/\s+/g, "") : "";
  const mac =
    marketplaceAccountId != null && String(marketplaceAccountId).trim() !== ""
      ? String(marketplaceAccountId).trim()
      : "";

  const absent = { present: false, expires_at: null, has_refresh: false, token_account_mismatch: false };

  try {
    if (mac) {
      let byMac = await supabase
        .from("ml_tokens")
        .select("expires_at, refresh_token, ml_user_id, marketplace_account_id")
        .eq("user_id", userId)
        .eq("marketplace", mp)
        .eq("marketplace_account_id", mac)
        .maybeSingle();

      if (byMac.error && isPostgrestMissingColumnError(byMac.error)) {
        byMac = await supabase
          .from("ml_tokens")
          .select("expires_at, refresh_token, ml_user_id")
          .eq("user_id", userId)
          .eq("marketplace", mp)
          .eq("marketplace_account_id", mac)
          .maybeSingle();
      }

      if (byMac.error && !isPostgrestMissingColumnError(byMac.error)) {
        return { ...absent };
      }

      if (byMac.data) {
        const tokMl = byMac.data.ml_user_id != null ? String(byMac.data.ml_user_id).trim().replace(/\s+/g, "") : "";
        if (ext && tokMl && tokMl !== ext) {
          console.error("[sync-status] token_account_mismatch", {
            marketplace_account_id: mac,
            external_seller_id: ext,
            ml_token_user_id: tokMl,
            resolved_via: "marketplace_account_id",
          });
          return {
            present: false,
            expires_at: null,
            has_refresh: false,
            token_account_mismatch: true,
            resolved_via: "marketplace_account_id",
          };
        }
        const p = probeFromTokenRow(byMac.data);
        p.resolved_via = "marketplace_account_id";
        return p;
      }
    }

    if (!ext) {
      return { ...absent };
    }

    const { data, error } = await supabase
      .from("ml_tokens")
      .select("expires_at, refresh_token, ml_user_id, marketplace_account_id")
      .eq("user_id", userId)
      .eq("marketplace", mp)
      .eq("ml_user_id", ext)
      .maybeSingle();

    if (error || !data) {
      return { ...absent };
    }

    if (mac) {
      const rowMac =
        data.marketplace_account_id != null && String(data.marketplace_account_id).trim() !== ""
          ? String(data.marketplace_account_id).trim()
          : "";
      if (rowMac && rowMac !== mac) {
        console.error("[sync-status] token_account_mismatch", {
          marketplace_account_id: mac,
          token_marketplace_account_id: rowMac,
          ml_user_id: ext,
          resolved_via: "ml_user_id",
        });
        return {
          present: false,
          expires_at: null,
          has_refresh: false,
          token_account_mismatch: true,
          resolved_via: "ml_user_id",
        };
      }
    }

    const p = probeFromTokenRow(data);
    p.resolved_via = "ml_user_id";
    return p;
  } catch {
    return { ...absent };
  }
}

/**
 * Legado: último token atualizado do usuário no marketplace (pode ser ambíguo com várias contas).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 */
export async function fetchMlTokenProbeForUser(supabase, userId, marketplace) {
  const mp = marketplace && String(marketplace).trim() !== "" ? String(marketplace).trim() : ML_MARKETPLACE_SLUG;
  try {
    const { data: rows, error } = await supabase
      .from("ml_tokens")
      .select("expires_at, refresh_token, ml_user_id")
      .eq("user_id", userId)
      .eq("marketplace", mp)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error || !Array.isArray(rows) || !rows[0]) {
      return { present: false, expires_at: null, has_refresh: false };
    }
    const data = rows[0];
    const hasRefresh = data.refresh_token != null && String(data.refresh_token).trim() !== "";
    return {
      present: true,
      expires_at: data.expires_at != null ? String(data.expires_at) : null,
      has_refresh: hasRefresh,
    };
  } catch {
    return { present: false, expires_at: null, has_refresh: false };
  }
}

/**
 * Contas com pelo menos um job ML inicial/backfill pendente ou em execução.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} accountIds
 * @param {string} marketplace
 */
export async function fetchMarketplaceAccountsWithActiveMlPipeline(supabase, accountIds, marketplace) {
  const ids = accountIds.map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length) return new Set();
  const mp = marketplace && String(marketplace).trim() !== "" ? String(marketplace).trim() : ML_MARKETPLACE_SLUG;
  try {
    const { data, error } = await supabase
      .from("marketplace_account_sync_jobs")
      .select("marketplace_account_id")
      .in("marketplace_account_id", ids)
      .eq("marketplace", mp)
      .in("job_type", ML_ALL_ACCOUNT_SYNC_JOB_TYPES)
      .in("status", ["pending", "running"])
      .limit(800);

    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.map((r) => String(r.marketplace_account_id || "")).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** @param {string | null | undefined} expiresAtIso */
function accessExpiredWithoutRefresh(expiresAtIso, hasRefresh) {
  if (hasRefresh) return false;
  if (!expiresAtIso) return true;
  const t = Date.parse(expiresAtIso);
  if (!Number.isFinite(t)) return true;
  return Date.now() >= t - ACCESS_SKEW_MS;
}

/**
 * @param {Record<string, unknown>} accountRow — marketplace_accounts
 * @param {{ present: boolean; expires_at: string | null; has_refresh: boolean }} tokenProbe
 * @param {boolean} pipelineActive
 * @returns {{
 *   connection_health: MlConnectionHealthCode;
 *   connection_badge_label: string;
 *   connection_alert_message: string | null;
 *   show_reconnect_cta: boolean;
 *   monitoring_headline: string | null;
 *   pipeline_active: boolean;
 * }}
 */
export function buildMlConnectionUiPack(accountRow, tokenProbe, pipelineActive) {
  const st = String(accountRow?.status ?? "unknown").toLowerCase();
  const pipeline = Boolean(pipelineActive);

  if (st === "removed") {
    return {
      connection_health: "disconnected",
      connection_badge_label: "Desconectada",
      connection_alert_message: "Esta conta foi removida do Suse7.",
      show_reconnect_cta: false,
      monitoring_headline: null,
      pipeline_active: pipeline,
    };
  }

  if (st === "expired" || st === "invalid") {
    return {
      connection_health: "auth_required",
      connection_badge_label: "Reconexão necessária",
      connection_alert_message:
        "Sua conta Mercado Livre perdeu a conexão. Reconecte para que o Suse7 continue monitorando vendas, anúncios e atualizações.",
      show_reconnect_cta: true,
      monitoring_headline: null,
      pipeline_active: pipeline,
    };
  }

  if (st !== "active") {
    return {
      connection_health: "unknown",
      connection_badge_label: "Status",
      connection_alert_message: null,
      show_reconnect_cta: false,
      monitoring_headline: null,
      pipeline_active: pipeline,
    };
  }

  if (!tokenProbe.present) {
    return {
      connection_health: "auth_required",
      connection_badge_label: "Reconexão necessária",
      connection_alert_message:
        "Sua conta Mercado Livre perdeu a conexão. Reconecte para que o Suse7 continue monitorando vendas, anúncios e atualizações.",
      show_reconnect_cta: true,
      monitoring_headline: null,
      pipeline_active: pipeline,
    };
  }

  if (accessExpiredWithoutRefresh(tokenProbe.expires_at, tokenProbe.has_refresh)) {
    return {
      connection_health: "auth_required",
      connection_badge_label: "Reconexão necessária",
      connection_alert_message:
        "Sua conta Mercado Livre perdeu a conexão. Reconecte para que o Suse7 continue monitorando vendas, anúncios e atualizações.",
      show_reconnect_cta: true,
      monitoring_headline: null,
      pipeline_active: pipeline,
    };
  }

  /** Conta ativa + token renovável ou ainda válido (pipeline em andamento não altera o badge de conexão). */
  return {
    connection_health: /** @type {MlConnectionHealthCode} */ ("connected"),
    connection_badge_label: "Ativa",
    connection_alert_message: null,
    show_reconnect_cta: false,
    monitoring_headline: "Monitoramento ativo",
    pipeline_active: pipeline,
  };
}

/**
 * @param {{
 *   overall?: string | null;
 *   historical_backfill_active?: boolean | null;
 *   stalled?: boolean | null;
 *   pending_queued_too_long?: boolean | null;
 *   checklist?: { key?: string; status?: string }[] | null;
 * }} syncPayload
 */
export function syncStatusNeedsAttention(syncPayload) {
  if (!syncPayload) return true;
  const ov = String(syncPayload.overall || "").toLowerCase();
  if (ov === "running" || ov === "error" || ov === "completed_with_errors") {
    return true;
  }
  if (syncPayload.historical_backfill_active === true) return true;
  if (syncPayload.stalled === true) return true;
  if (syncPayload.pending_queued_too_long === true) return true;
  const hist = Array.isArray(syncPayload.checklist)
    ? syncPayload.checklist.find((x) => String(x.key || "") === "historical_sales")
    : null;
  if (hist && String(hist.status || "").toLowerCase() === "error") return true;
  return false;
}
