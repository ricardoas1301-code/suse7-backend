// =============================================================================
// Env do provider WhatsApp ativo — Fase 3.5C.1.A1
// WHATSAPP_PROVIDER (preferido) ou S7_WHATSAPP_PROVIDER (legado S7)
// =============================================================================

import { config } from "../../../../../infra/config.js";

export const WHATSAPP_PROVIDER_NAMES = Object.freeze({
  ZAPI: "zapi",
  META_CLOUD: "meta_cloud",
  META: "meta",
  EVOLUTION: "evolution",
  TWILIO: "twilio",
  MOCK: "mock",
});

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeWhatsAppProviderName(raw) {
  const name = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (name === "metacloud" || name === "meta_cloud_api") return WHATSAPP_PROVIDER_NAMES.META_CLOUD;
  return name || WHATSAPP_PROVIDER_NAMES.MOCK;
}

/**
 * Provider ativo por config/env (sem resolver mock/sandbox/live).
 * @returns {string}
 */
export function resolveWhatsAppProviderName() {
  const fromEnv =
    process.env.WHATSAPP_PROVIDER != null && String(process.env.WHATSAPP_PROVIDER).trim() !== ""
      ? String(process.env.WHATSAPP_PROVIDER).trim()
      : process.env.S7_WHATSAPP_PROVIDER != null &&
          String(process.env.S7_WHATSAPP_PROVIDER).trim() !== ""
        ? String(process.env.S7_WHATSAPP_PROVIDER).trim()
        : config.s7WhatsAppProvider;
  return normalizeWhatsAppProviderName(fromEnv);
}
