// ======================================================
// HELPER — TOKEN MERCADO LIVRE (SUPE7)
// Uso interno (NÃO é rota)
//
// Responsabilidade:
// - Garantir SEMPRE um access_token válido
// - Renovar automaticamente via refresh_token
// - Atualizar Supabase de forma segura
// - Ser usado por TODAS as rotas ML
// ======================================================

import { createClient } from "@supabase/supabase-js";

// ------------------------------------------------------
// Função principal
// ------------------------------------------------------
export async function getValidMLToken(userId) {
  // ----------------------------------------------------
  // Validação básica
  // ----------------------------------------------------
  if (!userId) {
    throw new Error("getValidMLToken: userId não informado");
  }

  // ----------------------------------------------------
  // Supabase — Service Role (backend only)
  // ----------------------------------------------------
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ----------------------------------------------------
  // Buscar tokens no banco
  // ----------------------------------------------------
  const { data, error } = await supabase
    .from("ml_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("getValidMLToken: tokens do ML não encontrados");
  }

  const { access_token, refresh_token, expires_at } = data;

  // ----------------------------------------------------
  // Verificar expiração (com margem de segurança)
  // ----------------------------------------------------
  const now = Date.now();
  const expiresAt = new Date(expires_at).getTime();

  // margem de 60s para evitar token morrer no meio da request
  const isExpired = now >= expiresAt - 60 * 1000;

  // ----------------------------------------------------
  // Token ainda válido → retorna direto
  // ----------------------------------------------------
  if (!isExpired) {
    return access_token;
  }

  console.log("🔄 [ML] access_token expirado. Renovando automaticamente...");

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

  // ----------------------------------------------------
  // Validação do retorno do refresh
  // ----------------------------------------------------
  if (!refreshData?.access_token) {
    console.error("❌ [ML] Falha no refresh do token:", refreshData);
    throw new Error("getValidMLToken: falha ao renovar access_token");
  }

  // ----------------------------------------------------
  // expires_in pode não vir → fallback seguro (6h)
  // ----------------------------------------------------
  const expiresIn = refreshData.expires_in || 21600; // 6 horas

  const newExpiresAt = new Date(
    Date.now() + expiresIn * 1000
  ).toISOString();

  // ----------------------------------------------------
  // Atualizar tokens no Supabase
  // ----------------------------------------------------
  const { error: updateError } = await supabase
    .from("ml_tokens")
    .update({
      access_token: refreshData.access_token,
      refresh_token: refreshData.refresh_token || refresh_token,
      expires_at: newExpiresAt,
      expires_in: expiresIn,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) {
    console.error("❌ [ML] Erro ao salvar token renovado:", updateError);
    throw new Error("getValidMLToken: erro ao atualizar token no banco");
  }

  console.log("✅ [ML] Token renovado com sucesso");

  // ----------------------------------------------------
  // Retorna o NOVO token válido
  // ----------------------------------------------------
  return refreshData.access_token;
}
