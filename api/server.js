// ======================================================================
//  BACKEND SUSE7 — SERVER.JS (Vercel Serverless)
// ======================================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

// Criar app Express
const app = express();

// ======================================================================
//  MIDDLEWARES
// ======================================================================
app.use(express.json());

// 🔥 CORS PERMITINDO FRONTEND (LOCAL + PRODUÇÃO)
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
//  ROTAS MERCADO LIVRE
// ======================================================================
import mlRoutes from "./routes/mlRoutes.js";

// Todas rotas da API começam com /api
app.use("/api", mlRoutes);

// ======================================================================
//  EXPORTAR PARA VERCEL
// ======================================================================
export default app;
