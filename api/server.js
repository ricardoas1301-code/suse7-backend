// ======================================================================
//  BACKEND SUSE7 — SERVERLESS VERCEL (FORMATO CORRETO)
// ======================================================================

import express from "express";
import serverless from "serverless-http";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

// Criar app Express
const app = express();

// ======================================================================
//  MIDDLEWARES
// ======================================================================
app.use(express.json());

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://app.suse7.com.br",
      "https://suse7-frontend.vercel.app",
    ],
    credentials: true,
  })
);

// ======================================================================
// TESTE — ROTA BÁSICA
// ======================================================================
app.get("/api/hello", (req, res) => {
  return res.json({ message: "Backend SUSE7 OK!" });
});

// ======================================================================
// ROTAS MERCADO LIVRE
// ======================================================================
import mlRoutes from "./routes/mlRoutes.js";
app.use("/api", mlRoutes);

// ======================================================================
// EXPORTAR PARA O VERCEL (AQUI É O SEGREDO)
// ======================================================================
export const handler = serverless(app);
export default app;
