import express from "express";

const router = express.Router();

// ------------------------------------------------------
// TESTE — ROTA PARA CONFIRMAR SE O BACKEND FUNCIONA
// ------------------------------------------------------
router.get("/hello", (req, res) => {
  return res.json({ message: "Backend funcionando! 🚀" });
});

// ------------------------------------------------------
// STATUS FAKE TEMPORÁRIO (SEM req.user)
// ------------------------------------------------------
router.get("/ml/status", async (req, res) => {
  try {
    return res.json({
      connected: false,
      message: "Backend OK — ML ainda não conectado."
    });

  } catch (err) {
    console.error("Erro ao buscar status ML:", err);
    return res.status(500).json({ connected: false });
  }
});

export default router;
