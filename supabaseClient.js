// =======================================================
// SUPABASE CLIENT — BACKEND (SERVICE ROLE)
// Versão compatível com Vercel Serverless + Supabase
// =======================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "./src/infra/config.js";

if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  console.error("❌ ERRO: Variáveis do Supabase ausentes!");
}

// Criar client com SERVICE ROLE (backend)
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
