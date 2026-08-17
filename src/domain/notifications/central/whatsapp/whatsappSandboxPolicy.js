// =============================================================================
// Política sandbox WhatsApp — Fase 3.5B (whitelist + dev_sandbox)
// =============================================================================

import { config } from "../../../../infra/config.js";

/** Telefone padrão do laboratório quando env vazio em dev_sandbox. */
const DEFAULT_SANDBOX_WHITELIST = ["5511999999999"];

function envOrConfig(key, fallback = "") {
  const v = process.env[key];
  if (v != null && String(v).trim() !== "") return String(v).trim();
  return String(config[key] ?? fallback).trim();
}

/**
 * @returns {string[]}
 */
export function getWhatsAppSandboxWhitelist() {
  const raw = envOrConfig("S7_WHATSAPP_SANDBOX_WHITELIST", config.s7WhatsAppSandboxWhitelist);
  if (!raw) {
    return isDevSandboxWhatsAppMode() ? [...DEFAULT_SANDBOX_WHITELIST] : [];
  }
  return raw
    .split(/[,;\s]+/)
    .map((p) => p.replace(/\D/g, ""))
    .filter((p) => p.length >= 10);
}

/**
 * @returns {boolean}
 */
export function isDevSandboxWhatsAppMode() {
  const mode = envOrConfig("S7_WHATSAPP_MODE", config.s7WhatsAppMode).toLowerCase();
  return mode === "dev_sandbox" || mode === "sandbox";
}

/**
 * @param {string} phoneDigits
 */
export function isPhoneSandboxWhitelisted(phoneDigits) {
  const normalized = String(phoneDigits ?? "").replace(/\D/g, "");
  if (!normalized) return false;
  return getWhatsAppSandboxWhitelist().includes(normalized);
}

/**
 * @param {string} phoneDigits
 */
export function evaluateWhatsAppSendPolicy(phoneDigits) {
  const normalized = String(phoneDigits ?? "").replace(/\D/g, "");

  if (isDevSandboxWhatsAppMode()) {
    if (!isPhoneSandboxWhitelisted(normalized)) {
      return { allowed: false, reason: "NOT_WHITELISTED", mode: "dev_sandbox" };
    }
    return { allowed: true, reason: null, mode: "dev_sandbox" };
  }

  const whitelist = getWhatsAppSandboxWhitelist();
  if (whitelist.length > 0 && !whitelist.includes(normalized)) {
    const mode = envOrConfig("S7_WHATSAPP_MODE", config.s7WhatsAppMode).toLowerCase();
    if (mode === "live" || mode === "production") {
      return { allowed: false, reason: "NOT_WHITELISTED", mode };
    }
  }

  return {
    allowed: true,
    reason: null,
    mode: envOrConfig("S7_WHATSAPP_MODE", config.s7WhatsAppMode) || "mock",
  };
}
