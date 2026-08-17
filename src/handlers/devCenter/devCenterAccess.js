// ======================================================
// Dev Center — acesso admin (profiles.is_admin) + allowlist por e-mail
// S_4.8.3 — motor de autorização (sem permissões novas)
// Fonte: config.devCenterAllowedEmails ← SUSE7_DEV_CENTER_ALLOWED_EMAILS
// ======================================================

import { config } from "../../infra/config.js";

/** Códigos HTTP/API padronizados — evitar mensagens ambíguas. */
export const DEV_CENTER_AUTH_CODES = Object.freeze({
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
});

/** Mensagens neutras — 403 nunca usa "não encontrado". */
export const DEV_CENTER_AUTH_MESSAGES = Object.freeze({
  NO_TOKEN: "Token não informado",
  INVALID_TOKEN: "Token inválido",
  FORBIDDEN: "Acesso ao Dev Center restrito a usuários autorizados.",
});

/**
 * @param {{ email?: string | null } | null | undefined} user — objeto `user` de auth.getUser
 * @returns {boolean}
 */
export function isDevCenterAllowlistEmail(user) {
  if (!user || typeof user !== "object") return false;
  const email = user.email != null ? String(user.email).trim().toLowerCase() : "";
  if (!email) return false;
  const allowed = config.devCenterAllowedEmails;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.includes(email);
}

/** @deprecated use isDevCenterAllowlistEmail — mantido para imports legados */
export function isDevCenterAllowedUser(user) {
  return isDevCenterAllowlistEmail(user);
}

/**
 * Resolve se o usuário autenticado pode acessar o Dev Center.
 * Regra única: is_admin OR allowlist_email — sem caminho implícito.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ id?: string; email?: string | null } | null | undefined} user
 * @returns {Promise<{ allowed: boolean; is_admin: boolean; allowlist_email: boolean; reason: "admin" | "allowlist" | "denied" }>}
 */
export async function resolveDevCenterAccess(supabase, user) {
  if (!user?.id) {
    return { allowed: false, is_admin: false, allowlist_email: false, reason: "denied" };
  }

  const allowlist_email = isDevCenterAllowlistEmail(user);
  let is_admin = false;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("id", user.id)
        .maybeSingle();
      if (!error && data && data.is_admin === true) is_admin = true;
    } catch {
      /* coluna ausente em ambientes antigos — só allowlist */
    }
  }

  const allowed = is_admin || allowlist_email;
  /** @type {"admin" | "allowlist" | "denied"} */
  const reason = is_admin ? "admin" : allowlist_email ? "allowlist" : "denied";

  return { allowed, is_admin, allowlist_email, reason };
}
