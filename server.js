// ======================================================================
// BACKEND BÁSICO DO SUSE7
// Responsável por iniciar o servidor e carregar rotas do ML
// ======================================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config(); // Carrega variáveis do .env

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// Importação das rotas do Mercado Livre
// ---------------------------------------------------------
import mlRoutes from "./routes/mlRoutes.js";
app.use(mlRoutes);

// ---------------------------------------------------------
// Iniciar servidor
// ---------------------------------------------------------
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend do Suse7 rodando na porta ${PORT}`);
});
