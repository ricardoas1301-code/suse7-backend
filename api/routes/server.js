// ======================================================================
//  BACKEND SUSE7 — SERVER.JS (Vercel Serverless)
// ======================================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import serverless from "serverless-http";

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
      "https://suse7-frontend.vercel.app"
    ],
    credentials: true,
  })
);

// ======================================================================
//  ROTAS
// ======================================================================
import mlRoutes from "./routes/mlRoutes.js";

// Todas as rotas começam com /api
app.use("/api", mlRoutes);

// Rota de teste
app.get("/api/hello", (req, res) => {
  res.json({ message: "Suse7 Backend ativo!" });
});

// ======================================================================
//  EXPORTAÇÃO OBRIGATÓRIA PARA VERCEL
// ======================================================================

export default app;
export const handler = serverless(app);
