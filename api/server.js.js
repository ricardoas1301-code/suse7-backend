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

app.use("/api", mlRoutes);

// ======================================================================
//  ROTA DE TESTE
// ======================================================================
app.get("/api/hello", (req, res) => {
  res.json({ message: "Suse7 Backend ativo!" });
});

// ======================================================================
//  EXPORTAÇÃO CORRETA PARA O VERCEL
// ======================================================================
export default app;
