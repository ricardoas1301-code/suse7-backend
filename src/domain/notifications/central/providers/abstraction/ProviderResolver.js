// =============================================================================
// ProviderResolver — Fase 3.5C (facade por canal)
// =============================================================================

import { S7_PROVIDER_CHANNEL, isImplementedProviderChannel } from "./providerChannels.js";
import { resolveWhatsAppProviderAdapter } from "../whatsapp/resolveWhatsAppProviderAdapter.js";

/**
 * @param {string} channel
 * @returns {{
 *   adapter: import("./ProviderAdapter.js").ProviderAdapter;
 *   deliveryMode: import("./deliveryMode.js").DeliveryMode;
 *   tier: string;
 *   policyReason?: string;
 * }}
 */
export function resolveProviderAdapter(channel) {
  const ch = String(channel ?? "").trim();

  if (!isImplementedProviderChannel(ch)) {
    throw new Error(`PROVIDER_CHANNEL_NOT_IMPLEMENTED:${ch}`);
  }

  if (ch === S7_PROVIDER_CHANNEL.WHATSAPP) {
    return resolveWhatsAppProviderAdapter();
  }

  throw new Error(`PROVIDER_RESOLVER_MISSING:${ch}`);
}
