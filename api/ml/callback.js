import { createClient } from '@supabase/supabase-js';
import fetch from "node-fetch";


export default async function handler(req, res) {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).json({ error: "Code não encontrado" });
    }

    // Variáveis de ambiente
    const clientId = process.env.ML_CLIENT_ID;
    const clientSecret = process.env.ML_CLIENT_SECRET;
    const redirectUri = process.env.ML_REDIRECT_URI;

    // Trocar code por tokens
    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });

    const data = await tokenResponse.json();

    if (!data.access_token) {
      return res.status(500).json({
        error: "Erro ao obter tokens",
        ml_response: data
      });
    }

    // Conectar Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    // Salvar tokens no Supabase
    const { error } = await supabase
      .from("ml_tokens")
      .upsert({
        user_id: data.user_id,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.log("Supabase erro:", error);
      return res.status(500).json({ error: "Falha ao salvar tokens" });
    }

    // Redirecionar o usuário de volta ao frontend
    res.redirect("https://app.suse7.com.br/dashboard");

  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
}
