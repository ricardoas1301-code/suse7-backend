// ==================================================
// STATUS DA CONEXÃO MERCADO LIVRE — SUSE7
// Rota: /api/ml/status?user_id=UUID
//
// Objetivo:
// - Informar se a conta ML está conectada
// - Retornar ml_nickname salvo no Supabase
// - Manter token vivo via refresh automático (backend only)
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { getValidMLToken } from "./_helpers/mlToken.js";

async function handleMLStatus(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const { user_id } = req.query || {};

    if (!user_id) {
      return res.status(400).json({ error: "user_id não informado" });
    }

    const supabase = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey
    );

    const { data: mlData, error } = await supabase
      .from("ml_tokens")
      .select("access_token, expires_at, ml_nickname")
      .eq("user_id", user_id)
      .maybeSingle();

    if (error || !mlData?.access_token) {
      return res.json({
        connected: false,
        username: null,
        expires_at: null,
      });
    }

    try {
      await getValidMLToken(user_id);
    } catch (refreshErr) {
      console.warn(
        "[ML] Falha ao renovar token:",
        refreshErr?.message
      );
    }

    return res.json({
      connected: true,
      username: mlData.ml_nickname || null,
      expires_at: mlData.expires_at,
    });
  } catch (err) {
    console.error("Erro geral em /api/ml/status:", err);

    return res.status(500).json({
      connected: false,
      error: "Erro interno ao verificar status do Mercado Livre",
    });
  }
}

export default handleMLStatus;
