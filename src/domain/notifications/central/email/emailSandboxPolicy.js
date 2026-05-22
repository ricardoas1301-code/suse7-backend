// =============================================================================
// Política de envio — sandbox DEV (Fase 3.4.A)
// Whitelist obrigatória em dev_sandbox; bloqueio de destinatários não autorizados.
// =============================================================================

import { config } from "../../../../infra/config.js";

const DEFAULT_SANDBOX_WHITELIST = ["ricardoas1301@gmail.com"];

/**
 * @returns {string[]}
 */
export function getEmailSandboxWhitelist() {
  const raw = String(config.s7EmailSandboxWhitelist ?? "").trim();
  if (!raw) {
    return isDevSandboxEmailMode() ? [...DEFAULT_SANDBOX_WHITELIST] : [];
  }
  return raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/**
 * @returns {boolean}
 */
export function isDevSandboxEmailMode() {
  const mode = String(config.s7EmailMode ?? "").toLowerCase();
  return mode === "dev_sandbox" || mode === "sandbox";
}

/**
 * @param {string} email
 */
export function isEmailSandboxWhitelisted(email) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  const list = getEmailSandboxWhitelist();
  return list.includes(normalized);
}

/**
 * Avalia se o envio pode seguir (real ou simulado).
 * @param {string} to
 */
export function evaluateEmailSendPolicy(to) {
  const normalized = String(to ?? "").trim().toLowerCase();

  if (isDevSandboxEmailMode()) {
    if (!isEmailSandboxWhitelisted(normalized)) {
      return {
        allowed: false,
        forceSimulated: false,
        reason: "NOT_WHITELISTED",
        mode: "dev_sandbox",
      };
    }
    return {
      allowed: true,
      forceSimulated: false,
      reason: null,
      mode: "dev_sandbox",
    };
  }

  const whitelist = getEmailSandboxWhitelist();
  if (whitelist.length > 0 && !isEmailSandboxWhitelisted(normalized)) {
    const mode = String(config.s7EmailMode ?? "").toLowerCase();
    if (isDevSandboxEmailMode() || mode === "live" || mode === "production") {
      return {
        allowed: false,
        forceSimulated: false,
        reason: "NOT_WHITELISTED",
        mode,
      };
    }
  }

  return { allowed: true, forceSimulated: false, reason: null, mode: String(config.s7EmailMode ?? "mock") };
}
