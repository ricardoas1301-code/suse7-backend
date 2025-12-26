// ======================================================
// /api/ml/connect — OAuth Mercado Livre (Vercel)
// Inicia o OAuth (NÃO exige usuário logado)
// ======================================================

export default function handler(req, res) {
  try {
    // --------------------------------------------------
    // UUID do Supabase (opcional)
    // --------------------------------------------------
    const supabaseUserId = req.query.user_id || null;

    const clientId = process.env.ML_CLIENT_ID;
    const redirectUri = process.env.ML_REDIRECT_URI;

    // --------------------------------------------------
    // Logs de debug (Vercel)
    // --------------------------------------------------
    console.log("ML_CLIENT_ID:", clientId ? "OK" : "UNDEFINED");
    console.log("ML_REDIRECT_URI:", redirectUri ? "OK" : "UNDEFINED");
    console.log("Supabase User ID:", supabaseUserId || "NÃO INFORMADO");

    if (!clientId || !redirectUri) {
      return res.status(500).json({
        error: "ENV do Mercado Livre não disponível no runtime",
      });
    }

    // --------------------------------------------------
    // State (opcional, mas recomendado)
    // --------------------------------------------------
    const state = supabaseUserId
      ? encodeURIComponent(supabaseUserId)
      : undefined;

    // --------------------------------------------------
    // Montagem da URL de autorização
    // --------------------------------------------------
    let authUrl =
      "https://auth.mercadolivre.com.br/authorization" +
      "?response_type=code" +
      `&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`;

    if (state) {
      authUrl += `&state=${state}`;
    }

    return res.redirect(authUrl);

  } catch (err) {
    console.error("Erro /api/ml/connect:", err);
    return res.status(500).json({
      error: "Erro interno ML connect",
    });
  }
}
