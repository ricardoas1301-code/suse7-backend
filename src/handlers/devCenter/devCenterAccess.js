// ======================================================
// Dev Center — allowlist por e-mail (Supabase Auth JWT)
// Fonte: config.devCenterAllowedEmails ← SUSE7_DEV_CENTER_ALLOWED_EMAILS (default ricardo@suse7.com.br)
// ======================================================

import { config } from "../../infra/config.js";

/**
 * @param {{ email?: string | null } | null | undefined} user — objeto `user` de auth.getUser
 * @returns {boolean}
 */
export function isDevCenterAllowedUser(user) {
  if (!user || typeof user !== "object") return false;
  const email = user.email != null ? String(user.email).trim().toLowerCase() : "";
  if (!email) return false;
  const allowed = config.devCenterAllowedEmails;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.includes(email);
}
