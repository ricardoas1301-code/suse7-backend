// ======================================================
// /api/ml/connect — ENVIA UUID NO STATE
// ======================================================
export async function GET(req) {
  try {
    // --------------------------------------------------
    // 1) Ler user_id vindo do frontend
    // --------------------------------------------------
    const { searchParams } = new URL(req.url);
    const supabaseUserId = searchParams.get("user_id");

    if (!supabaseUserId) {
      return new Response(
        JSON.stringify({ error: "UUID do Supabase não informado" }),
        { status: 400 }
      );
    }

    // --------------------------------------------------
    // 2) Ler variáveis de ambiente do Mercado Livre
    // --------------------------------------------------
    const clientId = process.env.ML_CLIENT_ID;
    const redirectUri = process.env.ML_REDIRECT_URI;

    // Logs curtos para debug no Vercel (sem expor segredo)
    console.log("ML_CLIENT_ID:", clientId ? "OK" : "UNDEFINED");
    console.log("ML_REDIRECT_URI:", redirectUri ? "OK" : "UNDEFINED");

    if (!clientId || !redirectUri) {
      return new Response(
        JSON.stringify({
          error: "ENV do Mercado Livre não configurada no deploy",
          details: {
            ML_CLIENT_ID: clientId ? "OK" : "UNDEFINED",
            ML_REDIRECT_URI: redirectUri ? "OK" : "UNDEFINED",
          },
        }),
        { status: 500 }
      );
    }

    // --------------------------------------------------
    // 3) Montar URL de autorização (com state)
    // --------------------------------------------------
    const state = encodeURIComponent(supabaseUserId);

    const authUrl =
      "https://auth.mercadolivre.com.br/authorization" +
      "?response_type=code" +
      `&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    // --------------------------------------------------
    // 4) Redirect 302
    // --------------------------------------------------
    return Response.redirect(authUrl, 302);
  } catch (err) {
    console.error("Erro /api/ml/connect:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno no connect ML" }),
      { status: 500 }
    );
  }
}
