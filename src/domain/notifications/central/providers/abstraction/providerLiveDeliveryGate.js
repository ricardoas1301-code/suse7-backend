// =============================================================================
// Gate live — Fase 3.5C.1 (exige mode + flag; PROD sempre bloqueado)
// =============================================================================

import { config } from "../../../../../infra/config.js";
import { S7_DELIVERY_MODE, parseDeliveryMode } from "./deliveryMode.js";
import {
  isLiveDeliveryExplicitlyAllowed,
  resolveAppTier,
  S7_APP_TIER,
} from "./providerPolicy.js";

function envFlag(key, fallback = "") {
  const live = process.env[key];
  if (live != null && String(live).trim() !== "") return String(live).trim();
  return fallback;
}

/**
 * @returns {{ ok: boolean; error?: string }}
 */
export function assertWhatsAppLiveDeliveryEnabled() {
  const tier = resolveAppTier();
  if (tier === S7_APP_TIER.PROD) {
    return { ok: false, error: "PROD_LIVE_BLOCKED" };
  }

  const mode = parseDeliveryMode(envFlag("S7_WHATSAPP_MODE", config.s7WhatsAppMode));
  if (mode !== S7_DELIVERY_MODE.LIVE) {
    return { ok: false, error: "LIVE_DELIVERY_DISABLED" };
  }

  if (!isLiveDeliveryExplicitlyAllowed()) {
    return { ok: false, error: "LIVE_DELIVERY_DISABLED" };
  }

  return { ok: true };
}

/**
 * @returns {boolean}
 */
export function isWhatsAppLiveDeliveryEnabled() {
  return assertWhatsAppLiveDeliveryEnabled().ok;
}
