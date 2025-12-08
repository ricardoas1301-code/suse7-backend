// ======================================================================
// BACKEND DO SUSE7 — Serverless (Vercel)
// ======================================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Rotas
import mlRoutes from "./routes/mlRoutes.js";
app.use(mlRoutes);

// Exportar para Vercel (IMPORTANTE!)
export default app;
