// ======================================================
// /api/ml/refresh.js
// FUNÇÃO CENTRAL DE TOKEN — MERCADO LIVRE
// Objetivo:
// - Verificar se o access_token expirou
// - Renovar automaticamente usando refresh_token
// - Atualizar Supabase
// - Retornar SEMPRE um token válido
// ======================================================

import { createClient } from "@supabase/supabase-js";

// ------------------------------------------------------
// Função principal (exportável)
// ------------------------------------------------------
export async function getValidMLToken(userId) {
  // ----------------------------------------------------
  // Validação básica
  // ----------------------------------------------------
  if (!userId) {
    throw new Error("userId não informado para getValidMLToken");
  }

  // ----------------------------------------------------
  // Supabase (Service Role)
// ----------------------------------------------------
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ----------------------------------------------------
  // Buscar tokens no banco
  // ----------------------------------------------------
  const { data: tokenData, error } = await supabase
    .from("ml_tokens")
    .select(
      "access_token, refresh_token, expires_at, expires_in"
    )
    .eq("user_id", userId)
    .single();

  if (error || !tokenData) {
    throw new Error("Tokens do Mercado Livre não encontrados");
  }

  const { access_token, refresh_token, expires_at } = tokenData;

  // ----------------------------------------------------
  // Verificar se o token ainda é válido
  // (com margem de segurança de 60s)
  // ----------------------------------------------------
  const now = Date.now();
  const expiresAt = new Date(expires_at).getTime();

  const isExpired = now >= expiresAt - 60 * 1000;

  // ----------------------------------------------------
  // Se NÃO expirou → retorna direto
  // ----------------------------------------------------
  if (!isExpired) {
    return access_token;
  }

  console.log("🔄 Token ML expirado. Renovando automaticamente...");

  // ----------------------------------------------------
  // Refresh do token no Mercado Livre
  // ----------------------------------------------------
  const refreshResponse = await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        refresh_token: refresh_token,
      }),
    }
  );

  const refreshData = await refreshResponse.json();

  if (!refreshData.access_token) {
    console.error("❌ Erro ao renovar token ML:", refreshData);
    throw new Error("Falha ao renovar access_token do Mercado Livre");
  }

  // ----------------------------------------------------
  // Calcular novo expires_at
  // ----------------------------------------------------
  const newExpiresAt = new Date(
    Date.now() + refreshData.expires_in * 1000
  ).toISOString();

  // ----------------------------------------------------
  // Atualizar tokens no Supabase
  // ----------------------------------------------------
  const { error: updateError } = await supabase
    .from("ml_tokens")
    .update({
      access_token: refreshData.access_token,
      refresh_token: refreshData.refresh_token || refresh_token,
      expires_in: refreshData.expires_in,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) {
    console.error("❌ Erro ao atualizar token ML:", updateError);
    throw new Error("Erro ao salvar novo token do Mercado Livre");
  }

  console.log("✅ Token ML renovado com sucesso");

  // ----------------------------------------------------
  // Retorna o NOVO token válido
  // ----------------------------------------------------
  return refreshData.access_token;
}
