// ======================================================
// /api/ml/connect — ENVIA UUID NO STATE
// ======================================================
export async function GET(req) {
  const { searchParams } = new URL(req.url);

  const supabaseUserId = searchParams.get("user_id");

  if (!supabaseUserId) {
    return new Response(
      JSON.stringify({ error: "UUID do Supabase não informado" }),
      { status: 400 }
    );
  }

  const redirectUri = encodeURIComponent(process.env.ML_REDIRECT_URI);
  const state = encodeURIComponent(supabaseUserId);

const authUrl =
  "https://auth.mercadolivre.com.br/authorization" +
  "?response_type=code" +
  `&client_id=${process.env.ML_CLIENT_ID}` +
  `&redirect_uri=${redirectUri}` +
  `&state=${state}`; // 🔥 AGORA O ML NÃO IGNORA


  return Response.redirect(authUrl, 302);
}
