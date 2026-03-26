// ======================================================
// HELPER — TOKEN MERCADO LIVRE
// Uso interno (NÃO é rota)
// ======================================================

import { createClient } from "@supabase/supabase-js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";

export async function getValidMLToken(userId) {
  if (!userId) {
    throw new Error("userId não informado");
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from("ml_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .single();

  if (error || !data) {
    throw new Error("Tokens não encontrados");
  }

  const expiresAt = new Date(data.expires_at).getTime();
  const now = Date.now();

  if (now < expiresAt - 60 * 1000) {
    return data.access_token;
  }

  console.log("🔄 Renovando token ML...");

  const refreshBody = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ML_CLIENT_ID.trim(),
    client_secret: process.env.ML_CLIENT_SECRET.trim(),
    refresh_token: data.refresh_token,
  });

  const refreshResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: refreshBody.toString(),
  });

  const refreshData = await refreshResponse.json();

  if (!refreshData.access_token) {
    throw new Error("Falha ao renovar token");
  }

  const newExpiresAt = new Date(
    Date.now() + refreshData.expires_in * 1000
  ).toISOString();

  await supabase
    .from("ml_tokens")
    .update({
      access_token: refreshData.access_token,
      refresh_token: refreshData.refresh_token || data.refresh_token,
      expires_at: newExpiresAt,
      expires_in: refreshData.expires_in,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG);

  return refreshData.access_token;
}
