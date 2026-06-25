import { createClient } from "@supabase/supabase-js";
import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import { reconcileMarketplaceAccountFromMlTokensRow } from "../ml/_helpers/mlOAuthConnectPersistence.js";
import { config } from "../../infra/config.js";
import {
  buildMlConnectionUiPack,
  fetchMarketplaceAccountsWithActiveMlPipeline,
  fetchMlTokenProbeForMlSeller,
  fetchMlTokenProbeForUser,
} from "../../services/marketplace/marketplaceAccountConnectionHealth.js";

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function maskCnpjLast4(raw) {
  const d = raw != null ? String(raw).replace(/\D/g, "") : "";
  if (d.length < 4) return null;
  return `***${d.slice(-4)}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} companyIds
 */
async function loadSellerCompaniesForAccounts(supabase, userId, companyIds) {
  const uniq = [...new Set((companyIds || []).map((x) => String(x || "").trim()).filter(Boolean))];
  /** @type {Map<string, { trade_name?: string | null; company_name?: string | null; document_cnpj?: string | null; logo_url?: string | null; avatar_url?: string | null }>} */
  const map = new Map();
  if (!uniq.length) return map;
  const selectVariants = [
    "id, trade_name, company_name, document_cnpj, logo_url, avatar_url",
    "id, trade_name, company_name, document_cnpj, logo_url",
    "id, trade_name, company_name, document_cnpj",
  ];
  for (const sel of selectVariants) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select(sel)
      .eq("user_id", userId)
      .in("id", uniq.slice(0, 80));
    if (!error && Array.isArray(data)) {
      for (const r of data) {
        if (r?.id) map.set(String(r.id), r);
      }
      return map;
    }
    const errMsg = String(error?.message ?? "").toLowerCase();
    if (String(error?.code ?? "") !== "42703" && !errMsg.includes("column")) break;
  }
  return map;
}

function pickSafeAccount(row) {
  const nickname =
    row?.ml_nickname != null && String(row.ml_nickname).trim() !== ""
      ? String(row.ml_nickname).trim()
      : row?.account_alias != null && String(row.account_alias).trim() !== ""
        ? String(row.account_alias).trim()
        : row?.external_seller_id != null
          ? String(row.external_seller_id)
          : null;

  const pickUrl = (key) => {
    const v = row?.[key];
    return v != null && String(v).trim() !== "" ? String(v).trim() : null;
  };
  const accountLogoUrl =
    pickUrl("seller_company_logo_url") ??
    pickUrl("company_logo_url") ??
    pickUrl("account_logo_url") ??
    pickUrl("logo_url") ??
    pickUrl("avatar_url") ??
    pickUrl("ml_picture_url") ??
    null;

  return {
    marketplace_account_id: row?.id ?? null,
    id: row?.id ?? null,
    marketplace: row?.marketplace ?? "mercado_livre",
    nickname,
    ml_nickname: row?.ml_nickname ?? null,
    account_alias: row?.account_alias ?? null,
    seller_company_id: row?.seller_company_id ?? null,
    external_seller_id: row?.external_seller_id ?? null,
    company_name: row?.company_name ?? null,
    trade_name: row?.trade_name ?? null,
    company_trade_name: row?.company_trade_name ?? row?.trade_name ?? row?.company_name ?? null,
    company_document_masked: row?.company_document_masked ?? null,
    status: row?.status ?? "unknown",
    token_expires_at: row?.token_expires_at ?? null,
    ml_sales_last_sync_at: row?.ml_sales_last_sync_at ?? null,
    last_sync_at: row?.ml_sales_last_sync_at ?? null,
    logo_url: pickUrl("logo_url"),
    avatar_url: pickUrl("avatar_url"),
    account_logo_url: accountLogoUrl,
  };
}

async function loadAccounts(supabase, userId, marketplace) {
  const selectVariants = [
    "id, marketplace, seller_company_id, external_seller_id, status, ml_nickname, account_alias, token_expires_at, ml_sales_last_sync_at, logo_url, avatar_url, ml_picture_url, company_logo_url",
    "id, marketplace, seller_company_id, external_seller_id, status, ml_nickname, account_alias, token_expires_at, ml_sales_last_sync_at, logo_url, avatar_url",
    "id, marketplace, seller_company_id, external_seller_id, status, ml_nickname, account_alias, token_expires_at, ml_sales_last_sync_at",
    "id, marketplace, seller_company_id, external_seller_id, status, ml_nickname, account_alias",
    "id, marketplace, seller_company_id, external_seller_id, status",
    "id, seller_company_id, external_seller_id, status",
  ];

  for (const selectExpr of selectVariants) {
    let q = supabase.from("marketplace_accounts").select(selectExpr).eq("user_id", userId);
    if (marketplace) q = q.eq("marketplace", marketplace);
    const { data, error } = await q.order("created_at", { ascending: false });
    if (!error) return { data: toArray(data), error: null };
    const nonShapeError =
      String(error?.code ?? "") !== "42703" &&
      !String(error?.message ?? "").toLowerCase().includes("column");
    if (nonShapeError) return { data: [], error };
  }
  return { data: [], error: null };
}

export default async function handleMarketplaceAccounts(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({ ok: true, accounts: [] });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const marketplace = req.query?.marketplace != null ? String(req.query.marketplace).trim() : "";
  const filterMarketplace = marketplace || null;

  try {
    let { data, error } = await loadAccounts(supabase, user.id, filterMarketplace);
    if (error) {
      console.error("[Suse7][API][marketplace-accounts] failed", {
        user_id: user.id,
        marketplace_filter: filterMarketplace,
        table: "marketplace_accounts",
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      return res.status(200).json({ ok: true, accounts: [] });
    }

    let mlTokensCount = null;
    let mlTokenUserId = null;
    /** @type {{ id: string; ml_user_id: string | null; marketplace_account_id?: string | null }[]} */
    let mlTokenRows = [];
    try {
      const { count, error: cErr } = await supabase
        .from("ml_tokens")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("marketplace", "mercado_livre");
      if (!cErr && typeof count === "number") mlTokensCount = count;

      const { data: tok, error: tokErr } = await supabase
        .from("ml_tokens")
        .select("id, ml_user_id, marketplace_account_id")
        .eq("user_id", user.id)
        .eq("marketplace", "mercado_livre")
        .order("updated_at", { ascending: false })
        .limit(200);
      if (!tokErr && Array.isArray(tok)) {
        mlTokenRows = /** @type {typeof mlTokenRows} */ (tok);
        mlTokenUserId = mlTokenRows[0]?.ml_user_id != null ? String(mlTokenRows[0].ml_user_id) : null;
      }
    } catch {
      // diagnóstico best-effort
    }

    const mpSlug = filterMarketplace || ML_MARKETPLACE_SLUG;
    const hasMlTokensSignal =
      (typeof mlTokensCount === "number" && mlTokensCount > 0) || mlTokenRows.length > 0;
    if (
      data.length === 0 &&
      hasMlTokensSignal &&
      (!filterMarketplace || filterMarketplace === ML_MARKETPLACE_SLUG) &&
      typeof mlTokensCount === "number" &&
      mlTokensCount === 1
    ) {
      console.warn("[Suse7][API][marketplace-accounts] divergence_ml_tokens_without_marketplace_accounts", {
        user_id: user.id,
        marketplace_filter: filterMarketplace,
        ml_tokens_found_same_user: mlTokensCount,
        ml_tokens_top_ml_user_id: mlTokenUserId,
        reconcile_gate: "exactly_one_ml_token_row",
      });
      try {
        const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        /** Reconcile só materializa marketplace_account a partir de ml_tokens; não enfileira sync (NASA). */
        const rec = await reconcileMarketplaceAccountFromMlTokensRow(admin, user.id, {
          enqueueInitialSyncJobs: false,
        });
        if (rec.ok && rec.accountId) {
          const reload = await loadAccounts(supabase, user.id, filterMarketplace);
          if (!reload.error) {
            data = reload.data;
            console.info("[Suse7][API][marketplace-accounts] reconcile_applied", {
              user_id: user.id,
              marketplace_account_id: rec.accountId,
              accounts_after: data.length,
            });
          }
        }
      } catch (reconcileErr) {
        console.warn("[Suse7][API][marketplace-accounts] reconcile_failed", {
          user_id: user.id,
          message: reconcileErr?.message ?? String(reconcileErr),
        });
      }
    } else if (
      data.length === 0 &&
      hasMlTokensSignal &&
      (!filterMarketplace || filterMarketplace === ML_MARKETPLACE_SLUG) &&
      typeof mlTokensCount === "number" &&
      mlTokensCount > 1
    ) {
      console.warn("[Suse7][API][marketplace-accounts] reconcile_skipped_ambiguous_ml_tokens", {
        user_id: user.id,
        marketplace_filter: filterMarketplace,
        ml_tokens_count: mlTokensCount,
        hint: "Várias linhas ml_tokens para o usuário; não reconciliar automaticamente (evita conta errada).",
      });
    }

    const companyIds = data.map((r) => r?.seller_company_id).filter(Boolean).map(String);
    const companyById = await loadSellerCompaniesForAccounts(supabase, user.id, companyIds);

    const accountIdsForPipeline = data.map((r) => String(r?.id || "").trim()).filter(Boolean);
    const pipelineSet = await fetchMarketplaceAccountsWithActiveMlPipeline(supabase, accountIdsForPipeline, mpSlug);

    const rows = await Promise.all(
      data.map(async (row) => {
        const coId = row?.seller_company_id != null ? String(row.seller_company_id).trim() : "";
        const co = coId ? companyById.get(coId) : null;
        const tradeName = co?.trade_name != null ? String(co.trade_name).trim() : "";
        const companyName = co?.company_name != null ? String(co.company_name).trim() : "";
        const docMasked = co?.document_cnpj != null ? maskCnpjLast4(co.document_cnpj) : null;
        const rowEnriched = {
          ...row,
          company_name: companyName || null,
          trade_name: tradeName || null,
          company_trade_name: tradeName || companyName || null,
          company_document_masked: docMasked,
          company_logo_url:
            co?.logo_url != null && String(co.logo_url).trim() !== ""
              ? String(co.logo_url).trim()
              : co?.avatar_url != null && String(co.avatar_url).trim() !== ""
                ? String(co.avatar_url).trim()
                : null,
          seller_company_logo_url:
            co?.logo_url != null && String(co.logo_url).trim() !== ""
              ? String(co.logo_url).trim()
              : co?.avatar_url != null && String(co.avatar_url).trim() !== ""
                ? String(co.avatar_url).trim()
                : null,
        };
        const base = pickSafeAccount(rowEnriched);
        const ext = row?.external_seller_id != null ? String(row.external_seller_id).trim() : "";
        const tokenProbe = ext
          ? await fetchMlTokenProbeForMlSeller(supabase, user.id, mpSlug, ext, String(row.id))
          : await fetchMlTokenProbeForUser(supabase, user.id, mpSlug);
        const pack = buildMlConnectionUiPack(rowEnriched, tokenProbe, pipelineSet.has(String(row.id)));
        return {
          ...base,
          connection_health: pack.connection_health,
          connection_badge_label: pack.connection_badge_label,
          connection_alert_message: pack.connection_alert_message,
          show_reconnect_cta: pack.show_reconnect_cta,
          monitoring_headline: pack.monitoring_headline,
          pipeline_active: pack.pipeline_active,
          /** Backend: sync automático de vendas só é confiável com token/conexão saudáveis. */
          sales_auto_sync_effective:
            String(row?.status || "").toLowerCase() === "active" && pack.connection_health === "connected",
        };
      })
    );

    console.info("[accounts/list] marketplace_accounts_returned", {
      user_id: user.id,
      marketplace: mpSlug,
      count: rows.length,
      marketplace_account_ids: rows.map((r) => r.id).filter(Boolean),
      external_seller_ids: rows.map((r) => r.external_seller_id).filter(Boolean),
    });

    const tokenMlUserSet = new Set(
      mlTokenRows.map((t) => (t.ml_user_id != null ? String(t.ml_user_id).trim() : "")).filter(Boolean)
    );
    console.info("[accounts/list] token_alignment_summary", {
      user_id: user.id,
      marketplace: mpSlug,
      marketplace_accounts_count: rows.length,
      ml_tokens_count: mlTokensCount,
      ml_tokens_ml_user_ids_sample: [...tokenMlUserSet].slice(0, 30),
      per_account: rows.map((r) => {
        const ext = r.external_seller_id != null ? String(r.external_seller_id).trim() : "";
        return {
          marketplace_account_id: r.id ?? null,
          external_seller_id: ext || null,
          token_row_for_ml_user: ext ? tokenMlUserSet.has(ext) : false,
        };
      }),
    });

    console.info("[Suse7][API][marketplace-accounts] query_ok", {
      user_id: user.id,
      table: "marketplace_accounts",
      marketplace_filter: filterMarketplace,
      accounts_found: rows.length,
      accounts_with_seller_company_id: rows.filter((r) => r?.seller_company_id).length,
      first_account_id: rows[0]?.id ?? null,
      first_external_seller_id: rows[0]?.external_seller_id ?? null,
      ml_tokens_found_same_user: mlTokensCount,
      ml_tokens_top_ml_user_id: mlTokenUserId,
    });

    return res.status(200).json({
      ok: true,
      accounts: rows,
    });
  } catch (error) {
    console.error("[Suse7][API][marketplace-accounts] failed", {
      user_id: user.id,
      marketplace_filter: filterMarketplace,
      table: "marketplace_accounts",
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
    return res.status(200).json({ ok: true, accounts: [] });
  }
}
