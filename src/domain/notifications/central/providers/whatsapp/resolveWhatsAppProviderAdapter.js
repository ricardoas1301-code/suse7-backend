// =============================================================================
// Resolver WhatsApp — Fase 3.5C
// =============================================================================

import { config } from "../../../../../infra/config.js";
import { S7_DELIVERY_MODE } from "../abstraction/deliveryMode.js";
import {
  resolveEffectiveDeliveryPolicy,
  hasWhatsAppLiveCredentials,
} from "../abstraction/providerPolicy.js";
import { S7_PROVIDER_CHANNEL } from "../abstraction/providerChannels.js";
import { MockWhatsAppAdapter } from "./adapters/MockWhatsAppAdapter.js";
import { SandboxWhatsAppAdapter } from "./adapters/SandboxWhatsAppAdapter.js";
import { MetaWhatsAppAdapter } from "./adapters/MetaWhatsAppAdapter.js";
import { EvolutionWhatsAppAdapter } from "./adapters/EvolutionWhatsAppAdapter.js";
import { ZapiWhatsAppAdapter } from "./adapters/ZapiWhatsAppAdapter.js";
import { TwilioWhatsAppAdapter } from "./adapters/TwilioWhatsAppAdapter.js";

/** @type {Map<string, import("../abstraction/ProviderAdapter.js").ProviderAdapter>} */
const liveAdapterByName = new Map([
  ["meta", new MetaWhatsAppAdapter()],
  ["evolution", new EvolutionWhatsAppAdapter()],
  ["zapi", new ZapiWhatsAppAdapter()],
  ["twilio", new TwilioWhatsAppAdapter()],
]);

const mockAdapter = new MockWhatsAppAdapter();
const sandboxAdapter = new SandboxWhatsAppAdapter();

/**
 * @returns {{
 *   adapter: import("../abstraction/ProviderAdapter.js").ProviderAdapter;
 *   deliveryMode: import("../abstraction/deliveryMode.js").DeliveryMode;
 *   tier: string;
 *   policyReason?: string;
 * }}
 */
export function resolveWhatsAppProviderAdapter() {
  const policy = resolveEffectiveDeliveryPolicy(S7_PROVIDER_CHANNEL.WHATSAPP);

  if (policy.deliveryMode === S7_DELIVERY_MODE.SANDBOX) {
    return { adapter: sandboxAdapter, ...policy };
  }

  if (policy.deliveryMode === S7_DELIVERY_MODE.LIVE && hasWhatsAppLiveCredentials()) {
    const name = String(config.s7WhatsAppProvider ?? "mock").toLowerCase();
    const adapter = liveAdapterByName.get(name) ?? liveAdapterByName.get("meta");
    return { adapter: adapter ?? new MetaWhatsAppAdapter(), ...policy };
  }

  return { adapter: mockAdapter, deliveryMode: S7_DELIVERY_MODE.MOCK, tier: policy.tier, policyReason: policy.policyReason };
}
