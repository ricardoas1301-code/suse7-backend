// ======================================================
// HELPER — TOKEN MERCADO LIVRE
// Uso interno (NÃO é rota). Refresh: POST /oauth/token (x-www-form-urlencoded)
// Multi-conta: passe marketplaceAccountId ou mlUserId (external_seller_id ML).
// ======================================================

import { createClient } from "@supabase/supabase-js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { notifyMarketplaceAccountDisconnected } from "../../../domain/notifications/producers/notifyMarketplaceAccountDisconnected.js";

/**
 * Resolve o vendedor ML (ml_user_id / external_seller_id) usado na linha ml_tokens.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ marketplaceAccountId?: string | null, mlUserId?: string | null }} [ctx]
 * @returns {Promise<{ mlUserKey: string | null, marketplaceAccountId: string | null }>}
 */
async function resolveMlTokenScope(supabase, userId, ctx = {}) {
  const uid = String(userId || "").trim();
  const mp = ML_MARKETPLACE_SLUG;
  const rawMl = ctx.mlUserId != null && String(ctx.mlUserId).trim() !== "" ? String(ctx.mlUserId).trim() : null;
  if (rawMl) {
    return { mlUserKey: rawMl, marketplaceAccountId: null };
  }
  const accId =
    ctx.marketplaceAccountId != null && String(ctx.marketplaceAccountId).trim() !== ""
      ? String(ctx.marketplaceAccountId).trim()
      : null;
  if (accId) {
    const { data: acc, error } = await supabase
      .from("marketplace_accounts")
      .select("id, external_seller_id")
      .eq("id", accId)
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      console.warn("[ML_AUTH] resolve_scope_account_lookup_error", { message: error.message, code: error.code });
    }
    const ext =
      acc?.external_seller_id != null && String(acc.external_seller_id).trim() !== ""
        ? String(acc.external_seller_id).trim()
        : null;
    return { mlUserKey: ext, marketplaceAccountId: accId };
  }

  const { count, error: cErr } = await supabase
    .from("ml_tokens")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .eq("marketplace", mp);
  if (!cErr && typeof count === "number" && count > 1) {
    console.warn("[ML_AUTH] token_pick_ambiguous_multi_accounts", {
      user_id: uid,
      ml_tokens_rows: count,
      hint: "Passe marketplaceAccountId ou mlUserId em getValidMLToken.",
    });
  }

  return { mlUserKey: null, marketplaceAccountId: null };
}

/**
 * @param {string} userId
 * @param {{ marketplaceAccountId?: string | null, mlUserId?: string | null }} [ctx]
 * @returns {Promise<string>} access_token válido
 */
export async function getValidMLToken(userId, ctx = {}) {
  if (!userId) {
    throw new Error("userId não informado");
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const clientId = process.env.ML_CLIENT_ID?.trim();
  const clientSecret = process.env.ML_CLIENT_SECRET?.trim();

  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes");
  }
  if (!clientId || !clientSecret) {
    throw new Error("ML_CLIENT_ID ou ML_CLIENT_SECRET ausentes");
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { mlUserKey, marketplaceAccountId } = await resolveMlTokenScope(supabase, userId, ctx);

  let q = supabase
    .from("ml_tokens")
    .select("access_token, refresh_token, expires_at, ml_user_id")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG);
  if (mlUserKey) {
    q = q.eq("ml_user_id", mlUserKey);
  } else {
    q = q.order("updated_at", { ascending: false }).limit(1);
  }

  const { data: rows, error } = await q;
  const data = Array.isArray(rows) ? rows[0] : null;

  if (error) {
    console.error("[ML_AUTH] token_load_failed", {
      message: error.message,
      code: error.code,
      user_id: userId,
      ml_user_id: mlUserKey,
      marketplace_account_id: marketplaceAccountId,
    });
    throw new Error("Tokens não encontrados");
  }
  if (!data?.access_token) {
    console.error("[ML_AUTH] token_load_empty", {
      user_id: userId,
      ml_user_id: mlUserKey,
      marketplace_account_id: marketplaceAccountId,
    });
    throw new Error("Tokens não encontrados");
  }

  const refreshTok =
    data.refresh_token != null && String(data.refresh_token).trim() !== ""
      ? String(data.refresh_token).trim()
      : null;

  const expiresAtMs = data.expires_at ? new Date(data.expires_at).getTime() : 0;
  const now = Date.now();
  const skewMs = 60 * 1000;
  const isExpired = !Number.isFinite(expiresAtMs) || now >= expiresAtMs - skewMs;

  if (!isExpired) {
    console.info("[ML_AUTH] token_status: valid", {
      user_id: userId,
      ml_user_id: data.ml_user_id ?? mlUserKey ?? null,
      marketplace_account_id: marketplaceAccountId,
      expires_at: data.expires_at ?? null,
    });
    return String(data.access_token);
  }

  console.info("[ML_AUTH] token_status: expired", {
    user_id: userId,
    ml_user_id: data.ml_user_id ?? mlUserKey ?? null,
    marketplace_account_id: marketplaceAccountId,
    expires_at: data.expires_at ?? null,
  });

  if (!refreshTok) {
    const msg = "refresh_token ausente no banco; reconecte o Mercado Livre em Integrações.";
    console.error("[ML_AUTH] refresh_failed:", msg);
    void notifyMarketplaceAccountDisconnected({
      supabase,
      userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplaceAccountId,
      reason: "refresh_token_missing",
      source: "ml_token_refresh",
    });
    throw new Error(msg);
  }

  console.info("[ML_AUTH] refreshing_token...", {
    user_id: userId,
    marketplace: ML_MARKETPLACE_SLUG,
    ml_user_id: data.ml_user_id ?? mlUserKey ?? null,
    marketplace_account_id: marketplaceAccountId,
  });

  const refreshBody = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshTok,
  });

  const refreshResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: refreshBody.toString(),
  });

  const raw = await refreshResponse.text();
  /** @type {Record<string, unknown>} */
  let refreshData = {};
  try {
    refreshData = raw ? JSON.parse(raw) : {};
  } catch {
    refreshData = { _parse_error: true, raw: raw?.slice?.(0, 400) };
  }

  const accessNew = refreshData.access_token != null ? String(refreshData.access_token) : "";
  if (!refreshResponse.ok || !accessNew) {
    const desc =
      refreshData.error_description != null
        ? String(refreshData.error_description)
        : refreshData.message != null
          ? String(refreshData.message)
          : refreshData.error != null
            ? String(refreshData.error)
            : `HTTP ${refreshResponse.status}`;
    console.error("[ML_AUTH] refresh_failed:", desc, {
      http_status: refreshResponse.status,
      error: refreshData.error ?? null,
      body_preview: raw?.slice?.(0, 500) ?? null,
    });
    void notifyMarketplaceAccountDisconnected({
      supabase,
      userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplaceAccountId,
      reason: `oauth_refresh_failed:${desc.slice(0, 120)}`,
      source: "ml_oauth_refresh",
    });
    throw new Error(`Falha ao renovar token: ${desc}`);
  }

  const expiresInSec =
    typeof refreshData.expires_in === "number" && Number.isFinite(refreshData.expires_in)
      ? refreshData.expires_in
      : 21600;

  const newExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const newRefresh =
    refreshData.refresh_token != null && String(refreshData.refresh_token).trim() !== ""
      ? String(refreshData.refresh_token).trim()
      : refreshTok;

  const updatePayload = {
    access_token: accessNew,
    refresh_token: newRefresh,
    expires_at: newExpiresAt,
    expires_in: expiresInSec,
    updated_at: new Date().toISOString(),
  };

  if (refreshData.scope != null) {
    updatePayload.scope = String(refreshData.scope);
  }
  if (refreshData.token_type != null) {
    updatePayload.token_type = String(refreshData.token_type);
  }

  const rowMlUser =
    data.ml_user_id != null && String(data.ml_user_id).trim() !== "" ? String(data.ml_user_id).trim() : mlUserKey;
  if (!rowMlUser) {
    console.error("[ML_AUTH] refresh_persist_blocked_missing_ml_user_id", {
      user_id: userId,
      marketplace_account_id: marketplaceAccountId,
      db_ml_user_id: data.ml_user_id ?? null,
    });
    throw new Error(
      "Dados de token inconsistentes (ml_user_id ausente). Reconecte o Mercado Livre em Integrações."
    );
  }

  let updQ = supabase
    .from("ml_tokens")
    .update(updatePayload)
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("ml_user_id", rowMlUser);

  const { error: updErr } = await updQ;

  if (updErr) {
    console.error("[ML_AUTH] refresh_token_persist_failed", {
      message: updErr.message,
      code: updErr.code,
    });
    void notifyMarketplaceAccountDisconnected({
      supabase,
      userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplaceAccountId,
      reason: `token_persist_failed:${updErr.message?.slice?.(0, 80) ?? "unknown"}`,
      source: "ml_token_persist",
    });
    throw new Error(`Token renovado no ML mas falha ao salvar: ${updErr.message}`);
  }

  console.info("[ML_AUTH] refresh_success", {
    user_id: userId,
    ml_user_id: rowMlUser ?? null,
    marketplace_account_id: marketplaceAccountId,
    expires_at: newExpiresAt,
    refresh_rotated: newRefresh !== refreshTok,
  });

  const acctSyncIso = new Date().toISOString();
  let acctQ = supabase
    .from("marketplace_accounts")
    .update({ token_expires_at: newExpiresAt, updated_at: acctSyncIso })
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG);
  if (marketplaceAccountId) {
    acctQ = acctQ.eq("id", marketplaceAccountId);
  } else {
    acctQ = acctQ.eq("external_seller_id", rowMlUser);
  }
  const { error: acctExpErr } = await acctQ;
  if (acctExpErr) {
    console.warn("[ML_AUTH] marketplace_accounts_token_expires_sync_failed", {
      user_id: userId,
      marketplace_account_id: marketplaceAccountId ?? null,
      ml_user_id: rowMlUser ?? null,
      message: acctExpErr.message,
    });
  }

  return accessNew;
}
