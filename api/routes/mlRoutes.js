import express from "express";
import axios from "axios";
import { supabase } from "../supabaseClient.js";

const router = express.Router();

// ----------------------------------------------
// ROTA: CALLBACK DO MERCADO LIVRE
// ----------------------------------------------
router.get("/ml/callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: "Code não recebido." });
    }

    // Payload da troca
    const payload = {
      grant_type: "authorization_code",
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_SECRET_KEY,
      code,
      redirect_uri: process.env.ML_REDIRECT_URL,
    };

    // Solicita tokens ao Mercado Livre
    const tokenResponse = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const data = tokenResponse.data;

    // Salva tokens no Supabase
    const { error } = await supabase
      .from("ml_tokens")
      .upsert({
        user_id: req.user.id,
        ml_user_id: data.user_id,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        created_at: new Date(),
      });

    if (error) throw error;

    // Redireciona de volta ao painel
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?ml=connected`);

  } catch (err) {
    console.error("Erro no ML Callback:", err.response?.data || err);
    return res.status(500).json({ error: "Erro ao conectar Mercado Livre." });
  }
});

// ------------------------------------------------------
// ROTA: STATUS DA CONEXÃO DO MERCADO LIVRE
// ------------------------------------------------------
router.get("/ml/status", async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from("ml_tokens")
      .select("access_token, ml_user_id")
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      return res.json({ connected: false });
    }

    return res.json({
      connected: true,
      ml_user_id: data.ml_user_id,
    });

  } catch (err) {
    console.error("Erro ao buscar status ML:", err);
    return res.status(500).json({ connected: false });
  }
});

export default router;
