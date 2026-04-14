// ==================================================
// STATUS DA CONEXÃO MERCADO LIVRE — SUSE7
// Rota: /api/ml/status?user_id=UUID
//
// Responde sempre que possível com 200 + JSON (evita 500 por env vazio / Supabase).
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {unknown} q */
function singleQueryParam(q) {
  if (q == null) return "";
  if (typeof q === "string") return q.trim();
  if (Array.isArray(q) && q.length > 0) return String(q[0]).trim();
  return String(q).trim();
}

async function handleMLStatus(req, res) {
  if (!globalThis.__s7_ml_status_res_logged) {
    globalThis.__s7_ml_status_res_logged = true;
    console.info("[ML_STATUS] runtime_response_shape", {
      hasJson: typeof res.json === "function",
      hasStatus: typeof res.status === "function",
      hasEnd: typeof res.end === "function",
      hasWriteHead: typeof res.writeHead === "function",
    });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const emptyNotConnected = (errorMsg) =>
    res.status(200).json({
      connected: false,
      username: null,
      expires_at: null,
      ...(errorMsg ? { error: errorMsg } : {}),
    });

  try {
    const userRaw = singleQueryParam(req.query?.user_id);
    if (!userRaw) {
      return res.status(400).json({ error: "user_id não informado" });
    }
    if (!UUID_REGEX.test(userRaw)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    const supabaseUrl = (config.supabaseUrl || "").trim();
    const serviceKey = (config.supabaseServiceRoleKey || "").trim();
    if (!supabaseUrl || !serviceKey) {
      console.error("[ML_STATUS] supabase env ausente (verifique .env na raiz do suse7-backend)");
      return emptyNotConnected(
        "Backend sem SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY. Abra a pasta suse7-backend, configure o .env ou .env.local e reinicie npm run dev."
      );
    }

    let supabase;
    try {
      supabase = createClient(supabaseUrl, serviceKey);
    } catch (clientErr) {
      console.error("[ML_STATUS] createClient falhou", clientErr);
      return emptyNotConnected("Não foi possível conectar ao Supabase (URL ou chave inválida).");
    }

    const { data: mlData, error } = await supabase
      .from("ml_tokens")
      .select("access_token, expires_at, ml_nickname")
      .eq("user_id", userRaw)
      .eq("marketplace", ML_MARKETPLACE_SLUG)
      .maybeSingle();

    if (error) {
      console.error("[ML_STATUS] select ml_tokens", {
        message: error.message,
        code: error.code,
        details: error.details,
      });
      return emptyNotConnected(
        "Não foi possível ler ml_tokens no Supabase. Confira se a tabela existe e se a service role key está correta."
      );
    }

    if (!mlData?.access_token) {
      return res.status(200).json({
        connected: false,
        username: null,
        expires_at: null,
      });
    }

    try {
      await getValidMLToken(userRaw);
      return res.status(200).json({
        connected: true,
        username: mlData.ml_nickname || null,
        expires_at: mlData.expires_at,
      });
    } catch (refreshErr) {
      const msg = refreshErr?.message ? String(refreshErr.message) : "Falha ao renovar token";
      console.warn("[ML_STATUS] token_not_usable", { user_id: userRaw, message: msg });
      return res.status(200).json({
        connected: false,
        username: mlData.ml_nickname || null,
        expires_at: mlData.expires_at,
        error: msg,
      });
    }
  } catch (err) {
    console.error("[ML_STATUS] erro inesperado", err);
    return emptyNotConnected(
      err?.message
        ? `Erro ao verificar status: ${String(err.message)}`
        : "Erro interno ao verificar status do Mercado Livre."
    );
  }
}

export default handleMLStatus;
