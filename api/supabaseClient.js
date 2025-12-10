// ======================================================================
// SUPABASE CLIENT — BACKEND
// Usado para inserir tokens, buscar dados, atualizar registros, etc.
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// ------------------------------------------------------
// Variáveis do ambiente (colocadas no .env do backend)
// ------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ------------------------------------------------------
// Client com permissões do backend (SERVICE ROLE)
// ⚠️ Nunca usar a PUBLIC KEY aqui!
// ------------------------------------------------------
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});
