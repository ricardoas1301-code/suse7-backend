// ==================================================
// STATUS DA CONEXÃO MERCADO LIVRE — SERVERLESS
// Rota: /api/ml/status?user_id=UUID
// ==================================================

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // --------------------------------------------------
  // CORS (Whitelist de origens permitidas)
  // --------------------------------------------------
  const allowedOrigins = [
    "https://suse7.com.br",
    "https://app.suse7.com.br",
    "http://localhost:5173",
    "http://localhost:3000",
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Método não permitido" });
    }

    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id não informado" });
    }

    // --------------------------------------------------
    // CRIA CLIENT SUPABASE (SERVICE ROLE)
    // --------------------------------------------------
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // --------------------------------------------------
    // BUSCA TOKEN PELO UUID DO USUÁRIO
    // ATENÇÃO: aqui pode ser 'user_id' OU 'id' (depende da sua tabela)
    // --------------------------------------------------

    // ✅ TENTATIVA 1: coluna user_id
    let { data, error } = await supabase
      .from("ml_tokens")
      .select("access_token, expires_at")
      .eq("user_id", user_id)
      .maybeSingle();

    // ✅ FALLBACK: se não achou nada, tenta pela coluna id (muito comum)
    if (!data?.access_token) {
      const secondTry = await supabase
        .from("ml_tokens")
        .select("access_token, expires_at")
        .eq("id", user_id)
        .maybeSingle();

      data = secondTry.data;
      error = secondTry.error;
    }

    if (error || !data?.access_token) {
      return res.json({ connected: false });
    }

    return res.json({
      connected: true,
      expires_at: data.expires_at,
    });

  } catch (err) {
    console.error("Erro status ML:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
}
