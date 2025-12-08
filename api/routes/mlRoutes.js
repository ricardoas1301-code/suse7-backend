// ======================================================================
// ROTAS DO MERCADO LIVRE — SUSE7
// Responsável por trocar o "code" pelo token de acesso via OAuth 2.0
// ======================================================================

import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

// ------------------------------------------------------------
// ROTA: POST /ml/token
// Recebe o "code" do frontend e troca pelo access_token
// ------------------------------------------------------------
router.post("/ml/token", async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Code não enviado" });
    }

    // Dados necessários
    const client_id = process.env.ML_CLIENT_ID;
    const client_secret = process.env.ML_CLIENT_SECRET;
    const redirect_uri = process.env.ML_REDIRECT_URI;

    // --------------------------------------------------------
    // Fazer a requisição oficial ao Mercado Livre
    // --------------------------------------------------------
    const response = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      {
        grant_type: "authorization_code",
        client_id,
        client_secret,
        code,
        redirect_uri,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    console.log("TOKEN DO MERCADO LIVRE RECEBIDO:", response.data);

    return res.json(response.data);

  } catch (error) {
    console.error("Erro ao trocar code:", error.response?.data || error);
    res.status(500).json({ error: "Erro ao trocar o code por token" });
  }
});

export default router;
