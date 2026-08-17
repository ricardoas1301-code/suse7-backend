// =============================================================================
// ProviderSmokePolicy — rollout 1 seller / 1 phone / DEV|STAGING (3.5C.1)
// =============================================================================

import { config } from "../../../../../infra/config.js";
import { S7_APP_TIER, resolveAppTier } from "./providerPolicy.js";
import { assertWhatsAppLiveDeliveryEnabled } from "./providerLiveDeliveryGate.js";

function envFlag(key, fallback = "") {
  const live = process.env[key];
  if (live != null && String(live).trim() !== "") return String(live).trim();
  return fallback;
}

function normalizePhone(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * @returns {boolean}
 */
export function isProviderSmokeEnabled() {
  return envFlag("S7_PROVIDER_SMOKE_ENABLED", config.s7ProviderSmokeEnabled).toLowerCase() === "true";
}

/**
 * @param {{
 *   sellerId?: string | null;
 *   phone?: string | null;
 * }} input
 * @returns {{ allowed: boolean; reason?: string }}
 */
export function evaluateProviderSmokePolicy(input) {
  const liveGate = assertWhatsAppLiveDeliveryEnabled();
  if (!liveGate.ok) {
    return { allowed: false, reason: liveGate.error ?? "LIVE_DELIVERY_DISABLED" };
  }

  if (!isProviderSmokeEnabled()) {
    return { allowed: false, reason: "BLOCKED_BY_SMOKE_POLICY" };
  }

  const tier = resolveAppTier();
  if (tier !== S7_APP_TIER.DEV && tier !== S7_APP_TIER.STAGING) {
    return { allowed: false, reason: "BLOCKED_BY_SMOKE_POLICY" };
  }

  const expectedSeller = envFlag("S7_PROVIDER_SMOKE_SELLER", config.s7ProviderSmokeSeller).trim();
  const expectedPhone = normalizePhone(
    envFlag("S7_PROVIDER_SMOKE_PHONE", config.s7ProviderSmokePhone)
  );

  if (!expectedSeller || !expectedPhone) {
    return { allowed: false, reason: "BLOCKED_BY_SMOKE_POLICY" };
  }

  const sellerId = String(input.sellerId ?? "").trim();
  const phone = normalizePhone(input.phone);

  if (!sellerId || sellerId !== expectedSeller) {
    return { allowed: false, reason: "BLOCKED_BY_SMOKE_POLICY" };
  }

  if (!phone || phone !== expectedPhone) {
    return { allowed: false, reason: "BLOCKED_BY_SMOKE_POLICY" };
  }

  return { allowed: true };
}
