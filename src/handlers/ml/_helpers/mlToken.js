// ======================================================
// HELPER — TOKEN MERCADO LIVRE
// Uso interno (NÃO é rota). Refresh: POST /oauth/token (x-www-form-urlencoded)
// ======================================================

import { createClient } from "@supabase/supabase-js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";

/**
 * @param {string} userId
 * @returns {Promise<string>} access_token válido
 */
export async function getValidMLToken(userId) {
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

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data, error } = await supabase
    .from("ml_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .maybeSingle();

  if (error) {
    console.error("[ML_AUTH] token_load_failed", { message: error.message, code: error.code });
    throw new Error("Tokens não encontrados");
  }
  if (!data?.access_token) {
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
      expires_at: data.expires_at ?? null,
    });
    return data.access_token;
  }

  console.info("[ML_AUTH] token_status: expired", {
    user_id: userId,
    expires_at: data.expires_at ?? null,
  });

  if (!refreshTok) {
    const msg = "refresh_token ausente no banco; reconecte o Mercado Livre em Integrações.";
    console.error("[ML_AUTH] refresh_failed:", msg);
    throw new Error(msg);
  }

  console.info("[ML_AUTH] refreshing_token...", { user_id: userId, marketplace: ML_MARKETPLACE_SLUG });

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

  const { error: updErr } = await supabase
    .from("ml_tokens")
    .update(updatePayload)
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG);

  if (updErr) {
    console.error("[ML_AUTH] refresh_token_persist_failed", {
      message: updErr.message,
      code: updErr.code,
    });
    throw new Error(`Token renovado no ML mas falha ao salvar: ${updErr.message}`);
  }

  console.info("[ML_AUTH] refresh_success", {
    user_id: userId,
    expires_at: newExpiresAt,
    refresh_rotated: newRefresh !== refreshTok,
  });

  return accessNew;
}
