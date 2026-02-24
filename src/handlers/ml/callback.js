// ======================================================
// /api/ml/callback — RECEBE code + state (UUID)
// Objetivo:
// - Validar state (user_id Supabase)
// - Trocar code por token no Mercado Livre
// - Buscar dados do seller (GET /users/me) para capturar nickname
// - Salvar tokens + ml_nickname no Supabase (ml_tokens)
// - Redirecionar para /perfil/integracoes/mercado-livre
// ======================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";

export async function handleMLCallback(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Método não permitido" });
    }

    console.log("🔥 ML CALLBACK EXECUTADO", new Date().toISOString());

    const code = req.query?.code;
    const supabaseUserId = req.query?.state;

    if (!code) {
      return res.status(400).json({ error: "Code não encontrado" });
    }

    if (!supabaseUserId) {
      return res.status(400).json({ error: "State (UUID) não encontrado" });
    }

    const supabase = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey
    );

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", supabaseUserId)
      .maybeSingle();

    if (profileError || !profile) {
      console.error("❌ UUID inválido no callback ML:", supabaseUserId);
      return res.status(401).json({ error: "Usuário inválido para este state" });
    }

    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.mlClientId || process.env.ML_CLIENT_ID,
        client_secret: config.mlClientSecret || process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri: config.mlRedirectUri || process.env.ML_REDIRECT_URI,
      }),
    });

    const mlData = await tokenResponse.json();

    if (!mlData.access_token) {
      console.error("❌ Erro ao obter tokens ML:", mlData);

      const frontendUrl = config.frontendUrl || process.env.FRONTEND_URL;
      return res.redirect(
        `${frontendUrl}/perfil/integracoes/mercado-livre?ml_error=token`
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
          ml_user_id: String(mlData.user_id),
          ml_nickname: mlNickname,
          access_token: mlData.access_token,
          refresh_token: mlData.refresh_token,
          expires_in: mlData.expires_in,
          expires_at: expiresAt,
          scope: mlData.scope || null,
          token_type: mlData.token_type || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upsertError) {
      console.error("❌ Falha ao salvar tokens:", upsertError);

      const frontendUrl = config.frontendUrl || process.env.FRONTEND_URL;
      return res.redirect(
        `${frontendUrl}/perfil/integracoes/mercado-livre?ml_error=save`
      );
    }

    const frontendUrl = config.frontendUrl || process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/perfil/integracoes/mercado-livre`);
  } catch (err) {
    console.error("❌ Erro callback ML:", err);

    return res.status(500).json({
      error: "Erro interno no callback ML",
      details: err.message,
    });
  }
}
