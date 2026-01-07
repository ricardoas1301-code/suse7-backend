// ==================================================
// STATUS DA CONEXÃO MERCADO LIVRE — SERVERLESS
// Rota: /api/ml/status?user_id=UUID
// ==================================================

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // --------------------------------------------------
  // CORS — ORIGENS PERMITIDAS
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

  // --------------------------------------------------
  // APENAS GET É PERMITIDO
  // --------------------------------------------------
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // --------------------------------------------------
    // VALIDAÇÃO DE PARÂMETRO
    // --------------------------------------------------
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id não informado" });
    }

    // --------------------------------------------------
    // CLIENT SUPABASE (SERVICE ROLE)
    // --------------------------------------------------
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // --------------------------------------------------
    // BUSCA TOKEN DO MERCADO LIVRE
    // (primeiro por user_id, depois fallback por id)
    // --------------------------------------------------
    let tokenData = null;

    const firstTry = await supabase
      .from("ml_tokens")
      .select("access_token, expires_at")
      .eq("user_id", user_id)
      .maybeSingle();

    if (firstTry?.data?.access_token) {
      tokenData = firstTry.data;
    } else {
      const secondTry = await supabase
        .from("ml_tokens")
        .select("access_token, expires_at")
        .eq("id", user_id)
        .maybeSingle();

      if (secondTry?.data?.access_token) {
        tokenData = secondTry.data;
      }
    }

    // --------------------------------------------------
    // SE NÃO EXISTIR TOKEN → NÃO CONECTADO
    // --------------------------------------------------
    if (!tokenData?.access_token) {
      return res.json({ connected: false });
    }

    // --------------------------------------------------
    // BUSCAR DADOS DO USUÁRIO NO MERCADO LIVRE
    // Endpoint oficial: GET /users/me
    // --------------------------------------------------
    let username = null;

    try {
      const mlResponse = await fetch(
        "https://api.mercadolibre.com/users/me",
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        }
      );

      if (mlResponse.ok) {
        const mlUser = await mlResponse.json();
        username = mlUser?.nickname || null;
      }
    } catch (mlError) {
      console.error("Erro ao buscar usuário no Mercado Livre:", mlError);
    }

    // --------------------------------------------------
    // RESPOSTA FINAL
    // --------------------------------------------------
    return res.json({
      connected: true,
      expires_at: tokenData.expires_at,
      username, // ex: SUPER METALRIO
    });

  } catch (err) {
    console.error("Erro geral status ML:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
}
