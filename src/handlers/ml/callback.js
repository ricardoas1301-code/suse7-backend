// ======================================================
// /api/ml/callback — RECEBE code + state (token seguro)
// Objetivo:
// - Resolver state -> user_id via oauth_states
// - Trocar code por token no Mercado Livre
// - Buscar dados do seller (GET /users/me) para capturar nickname
// - Salvar tokens + ml_nickname no Supabase (ml_tokens)
// - Redirecionar para /perfil/integracoes/mercado-livre
// ======================================================

import { createClient } from "@supabase/supabase-js";
import {
  resolveAndConsumeOAuthState,
  validateEnv,
} from "./_helpers/oauthConnect.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";

const ML_CALLBACK_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ML_CLIENT_ID",
  "ML_CLIENT_SECRET",
  "ML_REDIRECT_URI",
  "FRONTEND_URL",
];

async function handleMLCallback(req, res) {
  const errorId = Date.now();
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Método não permitido" });
    }

    console.log("[ml/callback] EXECUTADO", new Date().toISOString());
    console.log("[ml/callback] req.query.code present?", !!req.query?.code);
    console.log("[ml/callback] req.query.state present?", !!req.query?.state);

    const code = req.query?.code;
    const state = req.query?.state;

    if (!code) {
      return res.status(400).json({ ok: false, error: "Code não encontrado" });
    }

    if (!state) {
      return res.status(400).json({ ok: false, error: "State não encontrado" });
    }

    // Validar ENV antes de qualquer operação
    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
    if (!envCheck.ok) {
      const msg = `Missing env: ${envCheck.missing.join(", ")}`;
      console.error("[ml/callback] errorId:", errorId, { missingEnv: envCheck.missing });
      return res.status(500).json({
        ok: false,
        error: msg,
        errorId,
      });
    }

    // Resolver user_id pelo state (oauth_states) e consumir state (one-time)
    const supabaseUserId = await resolveAndConsumeOAuthState(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      state,
      "ml"
    );

    if (!supabaseUserId) {
      console.error("[ml/callback] step_failed: resolve_state", { state });
      return res.status(401).json({ ok: false, error: "Invalid/expired state" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", supabaseUserId)
      .maybeSingle();

    if (profileError || !profile) {
      console.error("❌ Usuário inválido no callback ML:", supabaseUserId);
      return res.status(401).json({ error: "Usuário inválido para este state" });
    }

    const redirectUri = process.env.ML_REDIRECT_URI?.trim();
    if (!redirectUri) {
      return res.status(500).json({
        ok: false,
        error: "ML_REDIRECT_URI não configurada",
        errorId,
      });
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ML_CLIENT_ID.trim(),
      client_secret: process.env.ML_CLIENT_SECRET.trim(),
      code: typeof code === "string" ? code : String(code),
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    const mlData = await tokenResponse.json();

    if (!mlData.access_token) {
      console.error("[ml/callback] step_failed: exchange_code", mlData);

      const fe = process.env.FRONTEND_URL?.replace(/\/+$/, "") || "";
      return res.redirect(
        `${fe}/perfil/integracoes/mercado-livre?ml_error=token`
      );
    }

    const expiresAt = new Date(Date.now() + mlData.expires_in * 1000).toISOString();

    let mlNickname = null;

    try {
      const meResponse = await fetch("https://api.mercadolibre.com/users/me", {
        headers: {
          Authorization: `Bearer ${mlData.access_token}`,
        },
      });

      if (meResponse.ok) {
        const meData = await meResponse.json();
        mlNickname = meData?.nickname || null;
        console.log("✅ ML nickname capturado:", mlNickname);
      } else {
        console.warn("⚠️ Falha ao buscar /users/me:", meResponse.status);
      }
    } catch (meErr) {
      console.warn("⚠️ Erro ao buscar /users/me (ignorado):", meErr?.message);
    }

    const { error: upsertError } = await supabase
      .from("ml_tokens")
      .upsert(
        {
          user_id: supabaseUserId,
          marketplace: ML_MARKETPLACE_SLUG,
          ml_user_id: String(mlData.user_id),
          ml_nickname: mlNickname,
          access_token: mlData.access_token,
          refresh_token: mlData.refresh_token,
          expires_in: mlData.expires_in,
          expires_at: expiresAt,
          scope: mlData.scope ?? "",
          token_type: mlData.token_type ?? "bearer",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upsertError) {
      console.error("[ml/callback] step_failed: persist_tokens", upsertError);

      const fe = process.env.FRONTEND_URL?.replace(/\/+$/, "") || "";
      return res.redirect(
        `${fe}/perfil/integracoes/mercado-livre?ml_error=save`
      );
    }

    const fe = process.env.FRONTEND_URL?.replace(/\/+$/, "") || "";
    return res.redirect(
      `${fe}/perfil/integracoes/mercado-livre?ml=connected`
    );
  } catch (err) {
    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
    console.error("[ml/callback] errorId:", errorId, {
      message: err?.message,
      stack: err?.stack,
      missingEnv: envCheck.missing,
    });

    const diagnosticMsg = envCheck.ok
      ? err?.message || "Erro interno no callback ML"
      : `Missing env: ${envCheck.missing.join(", ")}`;

    return res.status(500).json({
      ok: false,
      error: diagnosticMsg,
      errorId,
    });
  }
}

export default handleMLCallback;
