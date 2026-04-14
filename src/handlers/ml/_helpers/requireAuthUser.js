// ======================================================
// Autenticação JWT (Supabase) para rotas /api/* com Bearer
// Retorno: { user, supabase } ou { error: { status, message } }
// ======================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../../infra/config.js";

/**
 * Valida Authorization: Bearer <access_token> e resolve o usuário Supabase.
 * Usa service role para auth.getUser (validação JWT); demais queries seguem o handler.
 */
export async function requireAuthUser(req) {
  const authHeader = req.headers?.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: { status: 401, message: "Token não informado" } };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { error: { status: 401, message: "Token não informado" } };
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user?.id) {
    return { error: { status: 401, message: "Token inválido ou sessão expirada" } };
  }

  return { user, supabase };
}
