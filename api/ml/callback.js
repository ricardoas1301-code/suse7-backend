// ======================================================
// /api/ml/callback — CALLBACK OAUTH MERCADO LIVRE
// Objetivo:
// 1. Receber code + state (UUID do Supabase)
// 2. Trocar code por access_token / refresh_token
// 3. Salvar tokens na tabela ml_tokens
// 4. Redirecionar para o dashboard do Suse7
// ======================================================

import { createClient } from "@supabase/supabase-js";

// ======================================================
// CLIENTE SUPABASE (SERVICE ROLE — BACKEND)
// ======================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// ======================================================
// HANDLER GET
// ======================================================
export async function GET(req) {
  try {
    // --------------------------------------------------
    // 1. CAPTURAR PARÂMETROS DO CALLBACK
    // --------------------------------------------------
    const { searchParams } = new URL(req.url);

    const code = searchParams.get("code");        // código OAuth
    const userId = searchParams.get("state");     // UUID do Supabase

    if (!code || !userId) {
      return new Response(
        JSON.stringify({ error: "Parâmetros inválidos no callback" }),
        { status: 400 }
      );
    }

    // --------------------------------------------------
    // 2. TROCAR CODE → TOKEN NO MERCADO LIVRE
    // --------------------------------------------------
    const tokenResponse = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: process.env.ML_CLIENT_ID,
          client_secret: process.env.ML_CLIENT_SECRET,
          code,
          redirect_uri: process.env.ML_REDIRECT_URI,
        }),
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      console.error("Erro ML token:", tokenData);
      return new Response(
        JSON.stringify({ error: "Falha ao obter token do ML" }),
        { status: 500 }
      );
    }

    // --------------------------------------------------
    // 3. CALCULAR DATA DE EXPIRAÇÃO
    // --------------------------------------------------
    const expiresAt = new Date(
      Date.now() + tokenData.expires_in * 1000
    ).toISOString();

    // --------------------------------------------------
    // 4. SALVAR TOKENS NO SUPABASE
    // --------------------------------------------------
    const { error } = await supabase
      .from("ml_tokens")
      .upsert({
        user_id: userId,                         // UUID do usuário
        ml_user_id: String(tokenData.user_id),   // ID do ML
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        expires_at: expiresAt,
        scope: tokenData.scope || null,
        token_type: tokenData.token_type || null,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error("Erro Supabase:", error);
      return new Response(
        JSON.stringify({ error: "Erro ao salvar token no Supabase" }),
        { status: 500 }
      );
    }

    // --------------------------------------------------
    // 5. REDIRECIONAR PARA O DASHBOARD
    // --------------------------------------------------
    return Response.redirect(
      `${process.env.FRONTEND_URL}/?ml=connected`,
      302
    );

  } catch (err) {
    console.error("Erro geral callback ML:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: err.message }),
      { status: 500 }
    );
  }
}
