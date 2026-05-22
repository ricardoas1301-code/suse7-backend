// =============================================================================
// Política por ambiente — Fase 3.5C (proíbe live acidental)
// =============================================================================

import { config } from "../../../../../infra/config.js";
import { S7_DELIVERY_MODE, parseDeliveryMode } from "./deliveryMode.js";
import { S7_PROVIDER_CHANNEL } from "./providerChannels.js";

export const S7_APP_TIER = Object.freeze({
  DEV: "dev",
  STAGING: "staging",
  PROD: "prod",
});

function envFlag(key, fallback = "") {
  const live = process.env[key];
  if (live != null && String(live).trim() !== "") return String(live).trim();
  return fallback;
}

/**
 * @returns {typeof S7_APP_TIER[keyof typeof S7_APP_TIER]}
 */
export function resolveAppTier() {
  const raw = String(
    envFlag("S7_APP_ENV", config.s7AppEnv) ||
      process.env.VERCEL_ENV ||
      process.env.NODE_ENV ||
      "development"
  )
    .trim()
    .toLowerCase();

  if (raw === "production" || raw === "prod") return S7_APP_TIER.PROD;
  if (raw === "staging" || raw === "preview") return S7_APP_TIER.STAGING;
  return S7_APP_TIER.DEV;
}

/**
 * @returns {boolean}
 */
export function isLiveDeliveryExplicitlyAllowed() {
  return envFlag("S7_ALLOW_LIVE_DELIVERY", config.s7AllowLiveDelivery).toLowerCase() === "true";
}

/**
 * @param {string} channel
 * @returns {import("./deliveryMode.js").DeliveryMode}
 */
export function resolveChannelDeliveryMode(channel) {
  const ch = String(channel ?? "").trim();

  if (ch === S7_PROVIDER_CHANNEL.WHATSAPP) {
    const parsed = parseDeliveryMode(envFlag("S7_WHATSAPP_MODE", config.s7WhatsAppMode));
    if (parsed) return parsed;
    if (hasWhatsAppLiveCredentials()) return S7_DELIVERY_MODE.LIVE;
    return S7_DELIVERY_MODE.MOCK;
  }

  return S7_DELIVERY_MODE.MOCK;
}

/**
 * @returns {boolean}
 */
export function hasWhatsAppLiveCredentials() {
  const provider = String(config.s7WhatsAppProvider ?? "").toLowerCase();
  if (provider === "zapi" && config.zapiToken) return true;
  if (provider === "evolution" && config.evolutionApiKey) return true;
  if (provider === "meta" && config.metaWhatsAppToken) return true;
  if (provider === "twilio" && config.twilioAuthToken) return true;
  return false;
}

/**
 * @param {import("./deliveryMode.js").DeliveryMode} requestedMode
 * @returns {{ allowed: boolean; effectiveMode: import("./deliveryMode.js").DeliveryMode; reason?: string }}
 */
export function enforceDeliveryModePolicy(requestedMode) {
  const tier = resolveAppTier();

  if (requestedMode === S7_DELIVERY_MODE.LIVE) {
    if (tier === S7_APP_TIER.DEV && !isLiveDeliveryExplicitlyAllowed()) {
      return {
        allowed: false,
        effectiveMode: S7_DELIVERY_MODE.MOCK,
        reason: "LIVE_BLOCKED_IN_DEV",
      };
    }
    if (tier === S7_APP_TIER.STAGING && !isLiveDeliveryExplicitlyAllowed()) {
      return {
        allowed: false,
        effectiveMode: S7_DELIVERY_MODE.SANDBOX,
        reason: "LIVE_REQUIRES_EXPLICIT_FLAG_IN_STAGING",
      };
    }
    if (!hasWhatsAppLiveCredentials()) {
      return {
        allowed: false,
        effectiveMode: S7_DELIVERY_MODE.MOCK,
        reason: "LIVE_CREDENTIALS_MISSING",
      };
    }
    return { allowed: true, effectiveMode: S7_DELIVERY_MODE.LIVE };
  }

  if (tier === S7_APP_TIER.PROD && requestedMode === S7_DELIVERY_MODE.MOCK) {
    const forced = hasWhatsAppLiveCredentials() ? S7_DELIVERY_MODE.LIVE : S7_DELIVERY_MODE.MOCK;
    return {
      allowed: true,
      effectiveMode: forced,
      reason: forced === S7_DELIVERY_MODE.LIVE ? "PROD_PREFERS_LIVE" : "PROD_NO_CREDENTIALS_MOCK_FALLBACK",
    };
  }

  return { allowed: true, effectiveMode: requestedMode };
}

/**
 * @param {string} channel
 * @returns {{ deliveryMode: import("./deliveryMode.js").DeliveryMode; tier: string; policyReason?: string }}
 */
export function resolveEffectiveDeliveryPolicy(channel) {
  const requested = resolveChannelDeliveryMode(channel);
  const enforced = enforceDeliveryModePolicy(requested);
  return {
    deliveryMode: enforced.effectiveMode,
    tier: resolveAppTier(),
    policyReason: enforced.reason,
  };
}

/**
 * @param {string} channel
 * @returns {boolean}
 */
export function isLiveDeliveryActive(channel) {
  const { deliveryMode } = resolveEffectiveDeliveryPolicy(channel);
  return deliveryMode === S7_DELIVERY_MODE.LIVE && hasWhatsAppLiveCredentials();
}
