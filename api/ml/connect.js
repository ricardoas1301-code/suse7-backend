// ======================================================
// /api/ml/connect — OAuth Mercado Livre (Vercel)
// ======================================================

export default function handler(req, res) {
  try {
    const supabaseUserId = req.query.user_id;

    if (!supabaseUserId) {
      return res.status(400).json({
        error: "UUID do Supabase não informado",
      });
    }

    const clientId = process.env.ML_CLIENT_ID;
    const redirectUri = process.env.ML_REDIRECT_URI;

    // 🔎 Logs de debug (ver no Vercel Logs)
    console.log("ML_CLIENT_ID:", clientId ? "OK" : "UNDEFINED");
    console.log("ML_REDIRECT_URI:", redirectUri ? "OK" : "UNDEFINED");

    if (!clientId || !redirectUri) {
      return res.status(500).json({
        error: "ENV do Mercado Livre não disponível no runtime",
      });
    }

    const state = encodeURIComponent(supabaseUserId);

    const authUrl =
      "https://auth.mercadolivre.com.br/authorization" +
      "?response_type=code" +
      `&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    return res.redirect(authUrl);
  } catch (err) {
    console.error("Erro /api/ml/connect:", err);
    return res.status(500).json({ error: "Erro interno ML connect" });
  }
}
