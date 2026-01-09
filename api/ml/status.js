// ==================================================
// STATUS DA CONEXÃO MERCADO LIVRE — SUSE7
// Rota: /api/ml/status?user_id=UUID
//
// Objetivo:
// - Informar se a conta ML está conectada
// - Retornar ml_nickname salvo no Supabase
// - Manter token vivo via refresh automático (backend only)
// - CORS fixo para PRODUÇÃO (Vercel-safe)
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "./_helpers/mlToken.js";

export default async function handler(req, res) {
  // --------------------------------------------------
  // CORS FIXO — PRODUÇÃO
  // (não depende de req.headers.origin)
  // --------------------------------------------------
  res.setHeader("Access-Control-Allow-Origin", "https://suse7.com.br");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  // --------------------------------------------------
  // Preflight
  // --------------------------------------------------
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // --------------------------------------------------
  // Apenas GET
  // --------------------------------------------------
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // --------------------------------------------------
    // Validação de parâmetros
    // --------------------------------------------------
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id não informado" });
    }

    // --------------------------------------------------
    // Supabase — Service Role
    // --------------------------------------------------
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // --------------------------------------------------
    // Buscar dados da integração no banco
    // --------------------------------------------------
    const { data: mlData, error } = await supabase
      .from("ml_tokens")
      .select("access_token, expires_at, ml_nickname")
      .eq("user_id", user_id)
      .maybeSingle();

    // --------------------------------------------------
    // Não conectado
    // --------------------------------------------------
    if (error || !mlData?.access_token) {
      return res.json({
        connected: false,
        username: null,
        expires_at: null,
      });
    }

    // --------------------------------------------------
    // Manutenção silenciosa do token
    // (NÃO afeta UX se falhar)
    // --------------------------------------------------
    try {
      await getValidMLToken(user_id);
    } catch (refreshErr) {
      console.warn(
        "⚠️ [ML] Não foi possível renovar token agora:",
        refreshErr?.message
      );
    }

    // --------------------------------------------------
    // Resposta final para o frontend
    // --------------------------------------------------
    return res.json({
      connected: true,
      username: mlData.ml_nickname || null,
      expires_at: mlData.expires_at,
    });
  } catch (err) {
  console.error("❌ Erro geral em /api/ml/status:", err);

  return res.status(500).json({
    connected: false,
    error: "Erro interno ao verificar status do Mercado Livre"
  });
  }
}
