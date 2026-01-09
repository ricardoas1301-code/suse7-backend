// ==================================================
// STATUS DA CONEXÃO MERCADO LIVRE — SERVERLESS
// Rota: /api/ml/status?user_id=UUID
// Objetivo:
// - Retornar status de conexão SEM depender de chamada ao ML em tempo real
// - Exibir ml_nickname salvo no banco (UX estável)
// - Renovar token automaticamente se estiver expirado/perto de expirar (backend only)
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "./refresh";

// --------------------------------------------------
// Helper: CORS — origens permitidas
// --------------------------------------------------
function applyCors(req, res) {
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
}

export default async function handler(req, res) {
  // --------------------------------------------------
  // CORS
  // --------------------------------------------------
  applyCors(req, res);

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
    // Validação de parâmetro
    // --------------------------------------------------
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id não informado" });
    }

    // --------------------------------------------------
    // Supabase (Service Role)
    // --------------------------------------------------
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // --------------------------------------------------
    // Buscar dados da integração no banco
    // (SEM chamar ML em tempo real)
    // --------------------------------------------------
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("ml_tokens")
      .select("access_token, refresh_token, expires_at, ml_nickname")
      .eq("user_id", user_id)
      .maybeSingle();

    // --------------------------------------------------
    // Se não existir registro de token → NÃO conectado
    // --------------------------------------------------
    if (tokenErr || !tokenRow?.access_token) {
      return res.json({
        connected: false,
        expires_at: null,
        username: null,
      });
    }

    // --------------------------------------------------
    // Renovação automática (se necessário)
    // - Isso garante que o backend mantenha o token vivo
    // - Mesmo que o status do frontend não use o token
    // --------------------------------------------------
    try {
      await getValidMLToken(user_id);
    } catch (refreshErr) {
      // Importante: NÃO derrubar o status por falha de refresh.
      // Apenas logar para debug e manter a UI estável.
      console.warn("⚠️ Falha ao renovar token automaticamente:", refreshErr?.message);
    }

    // --------------------------------------------------
    // Resposta final (UX estável)
    // --------------------------------------------------
    return res.json({
      connected: true,
      expires_at: tokenRow.expires_at,
      username: tokenRow.ml_nickname || null,
    });
  } catch (err) {
    console.error("Erro geral status ML:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
}
