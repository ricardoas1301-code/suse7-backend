// ======================================================
// HELPERS — OAuth Connect (Strategy/Adapter para marketplaces)
// Uso: ML connect, futuros marketplaces (Shopee, etc.)
// ======================================================

import { randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------
// validateEnv — Valida variáveis de ambiente necessárias
// Retorna: { ok: boolean, missing: string[] }
// ----------------------------------------------
export function validateEnv(requiredKeys) {
  const missing = requiredKeys.filter((key) => !process.env[key]?.trim());
  return {
    ok: missing.length === 0,
    missing,
  };
}

// ----------------------------------------------
// generateSecureState — Gera state seguro (randomBytes + base64url)
// ----------------------------------------------
export function generateSecureState() {
  const bytes = randomBytes(32);
  return bytes.toString("base64url");
}

// ----------------------------------------------
// buildMlAuthUrl — Monta URL OAuth do Mercado Livre
// ----------------------------------------------
export function buildMlAuthUrl(clientId, redirectUri, state) {
  const base = "https://auth.mercadolivre.com.br/authorization";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${base}?${params.toString()}`;
}

// ----------------------------------------------
// persistOAuthState — Persiste state no Supabase (service role, bypass RLS)
// Retorna { data, error } para diagnóstico (não lança)
// ----------------------------------------------
export async function persistOAuthState(supabaseUrl, serviceRoleKey, state, userId, marketplace = "ml") {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { data, error } = await supabase.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace,
    expires_at: expiresAt,
  });

  return { data, error };
}

// ----------------------------------------------
// resolveOAuthState — Busca user_id pelo state (callback)
// Retorna user_id ou null se expirado/inválido
// ----------------------------------------------
export async function resolveOAuthState(supabaseUrl, serviceRoleKey, state, marketplace = "ml") {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase
    .from("oauth_states")
    .select("user_id")
    .eq("state", state)
    .eq("marketplace", marketplace)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;
  return data.user_id;
}
