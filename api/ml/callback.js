// ======================================================
// /api/ml/callback — RECEBE CODE + STATE (UUID)
// Objetivo: Trocar o code por token do ML e salvar
//           os tokens no Supabase com segurança
// ======================================================

import { createClient } from "@supabase/supabase-js";

export async function GET(req) {
  try {
    // --------------------------------------------------
    // 1. CAPTURAR PARÂMETROS DA URL
    // --------------------------------------------------
    const { searchParams } = new URL(req.url);

    const code = searchParams.get("code");
    const supabaseUserId = searchParams.get("state"); // UUID do Supabase

    if (!code) {
      return new Response(
        JSON.stringify({ error: "Code não encontrado" }),
        { status: 400 }
      );
    }

    if (!supabaseUserId) {
      return new Response(
        JSON.stringify({ error: "State (UUID) não encontrado" }),
        { status: 400 }
      );
    }

    // --------------------------------------------------
    // 2. CRIAR CLIENT DO SUPABASE (SERVICE ROLE)
    // --------------------------------------------------
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // --------------------------------------------------
    // 3. TROCAR CODE POR TOKEN NO MERCADO LIVRE
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

    const data = await tokenResponse.json();

    if (!data.access_token) {
      return new Response(
        JSON.stringify({
          error: "Erro ao obter tokens do Mercado Livre",
          ml_response: data,
        }),
        { status: 500 }
      );
    }

    // --------------------------------------------------
    // 4. CALCULAR DATA DE EXPIRAÇÃO
    // --------------------------------------------------
    const expiresAt = new Date(
      Date.now() + data.expires_in * 1000
    ).toISOString();

    // --------------------------------------------------
    // 5. SALVAR TOKENS NO SUPABASE
    // --------------------------------------------------
    const { error } = await supabase
      .from("ml_tokens")
      .upsert({
        user_id: supabaseUserId,
        ml_user_id: String(data.user_id),
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        expires_at: expiresAt,
        scope: data.scope || null,
        token_type: data.token_type || null,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error("❌ Erro Supabase:", error);
      return new Response(
        JSON.stringify({
          error: "Falha ao salvar tokens",
          details: error,
        }),
        { status: 500 }
      );
    }

    // --------------------------------------------------
    // 6. REDIRECIONAR DE VOLTA AO FRONTEND
    // --------------------------------------------------
    return Response.redirect(
      `${process.env.FRONTEND_URL}/dashboard?ml=connected`,
      302
    );

  } catch (err) {
    console.error("🔥 Erro no callback ML:", err);
    return new Response(
      JSON.stringify({
        error: "Erro interno",
        details: err.message,
      }),
      { status: 500 }
    );
  }
}
