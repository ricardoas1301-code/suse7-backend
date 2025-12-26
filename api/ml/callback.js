// ======================================================
// /api/ml/callback — RECEBE CODE + STATE (UUID)
// ======================================================

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function GET(req) {
  try {
    // --------------------------------------------------
    // CAPTURA DOS PARÂMETROS
    // --------------------------------------------------
    const { searchParams } = new URL(req.url);

    const code = searchParams.get("code");
    const supabaseUserId = searchParams.get("state"); // ✅ UUID DO SUPABASE

    if (!code) {
      return new Response(JSON.stringify({ error: "Code não encontrado" }), {
        status: 400,
      });
    }

    if (!supabaseUserId) {
      return new Response(
        JSON.stringify({ error: "State (UUID) não encontrado" }),
        { status: 400 }
      );
    }

    // ===================================================
    // 🔐 VALIDAÇÃO REAL DO STATE (UUID EXISTE NO SUPABASE)
    // ===================================================
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", supabaseUserId)
        .maybeSingle();

      if (profileError || !profile) {
          console.error("❌ UUID inválido no callback ML:", supabaseUserId);
          return new Response(
          JSON.stringify({ error: "Usuário inválido para este state" }),
          { status: 401 }
        );
      }


    // --------------------------------------------------
    // TROCA CODE → TOKEN (Mercado Livre)
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
          error: "Erro ao obter tokens",
          ml_response: data,
        }),
        { status: 500 }
      );
    }

    // ================================
// SALVAR TOKENS CORRETAMENTE
// ================================
const expiresAt = new Date(
  Date.now() + data.expires_in * 1000
).toISOString();

const { error } = await supabase
  .from("ml_tokens")
  .upsert({
    user_id: supabaseUserId,        // ✅ UUID DO SUPABASE (state)
    ml_user_id: String(data.user_id), // ✅ ID DO ML (texto)
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: expiresAt,
    scope: data.scope || null,
    token_type: data.token_type || null,
    updated_at: new Date().toISOString()
  });

if (error) {
  console.error("Supabase ERROR →", error);
  return new Response(
    JSON.stringify({
      error: "Falha ao salvar tokens",
      details: error
    }),
    { status: 500 }
  );
}

    // --------------------------------------------------
    // REDIRECIONA PARA O FRONTEND
    // --------------------------------------------------
    return Response.redirect(
  `${process.env.FRONTEND_URL}/?ml=connected`
);

  } catch (err) {
    console.error("Erro callback →", err);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: err.message }),
      { status: 500 }
    );
  }
}
