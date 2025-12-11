// =======================================================
// SUPABASE CLIENT — BACKEND (SERVICE ROLE)
// Versão compatível com Vercel Serverless + Supabase
// =======================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// Carrega variáveis do ambiente
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("❌ ERRO: Variáveis do Supabase ausentes!");
}

// Criar client com SERVICE ROLE (backend)
export const supabase = createClient(
  supabaseUrl,
  supabaseServiceKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);
