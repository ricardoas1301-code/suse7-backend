// =============================================================================
// Resolver central de providers WhatsApp — Fase 3.5C.1.A1
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
import { TwilioWhatsAppAdapter } from "./adapters/TwilioWhatsAppAdapter.js";
import { ZapiWhatsAppProvider } from "./ZapiWhatsAppProvider.js";
import { MetaCloudWhatsAppProvider } from "./MetaCloudWhatsAppProvider.js";
import {
  resolveWhatsAppProviderName,
  WHATSAPP_PROVIDER_NAMES,
} from "./whatsappProviderEnv.js";

const mockAdapter = new MockWhatsAppAdapter();
const sandboxAdapter = new SandboxWhatsAppAdapter();

/** @type {Map<string, import("./WhatsAppProviderStrategy.js").WhatsAppProviderStrategy>} */
const liveProviderByName = new Map([
  [WHATSAPP_PROVIDER_NAMES.ZAPI, new ZapiWhatsAppProvider()],
  [WHATSAPP_PROVIDER_NAMES.META_CLOUD, new MetaCloudWhatsAppProvider()],
  [WHATSAPP_PROVIDER_NAMES.META, new MetaWhatsAppAdapter()],
  [WHATSAPP_PROVIDER_NAMES.EVOLUTION, new EvolutionWhatsAppAdapter()],
  [WHATSAPP_PROVIDER_NAMES.TWILIO, new TwilioWhatsAppAdapter()],
]);

/**
 * Nome do provider configurado (env).
 * @returns {string}
 */
export function resolveActiveWhatsAppProviderName() {
  return resolveWhatsAppProviderName();
}

/**
 * @returns {import("./WhatsAppProviderStrategy.js").WhatsAppProviderStrategy | import("../abstraction/ProviderAdapter.js").ProviderAdapter}
 */
export function resolveWhatsAppProviderStrategy() {
  const policy = resolveEffectiveDeliveryPolicy(S7_PROVIDER_CHANNEL.WHATSAPP);

  if (policy.deliveryMode === S7_DELIVERY_MODE.SANDBOX) {
    return sandboxAdapter;
  }

  if (policy.deliveryMode === S7_DELIVERY_MODE.LIVE && hasWhatsAppLiveCredentials()) {
    const name = resolveWhatsAppProviderName();
    const strategy =
      liveProviderByName.get(name) ??
      liveProviderByName.get(WHATSAPP_PROVIDER_NAMES.META) ??
      new MetaWhatsAppAdapter();
    return strategy;
  }

  return mockAdapter;
}

/**
 * @returns {{
 *   adapter: import("../abstraction/ProviderAdapter.js").ProviderAdapter;
 *   deliveryMode: import("../abstraction/deliveryMode.js").DeliveryMode;
 *   tier: string;
 *   policyReason?: string;
 *   configured_provider: string;
 * }}
 */
export function resolveWhatsAppProviderAdapter() {
  const policy = resolveEffectiveDeliveryPolicy(S7_PROVIDER_CHANNEL.WHATSAPP);
  const configured_provider = resolveWhatsAppProviderName();

  if (policy.deliveryMode === S7_DELIVERY_MODE.SANDBOX) {
    return { adapter: sandboxAdapter, ...policy, configured_provider };
  }

  if (policy.deliveryMode === S7_DELIVERY_MODE.LIVE && hasWhatsAppLiveCredentials()) {
    const adapter = resolveWhatsAppProviderStrategy();
    return { adapter, ...policy, configured_provider };
  }

  return {
    adapter: mockAdapter,
    deliveryMode: S7_DELIVERY_MODE.MOCK,
    tier: policy.tier,
    policyReason: policy.policyReason,
    configured_provider,
  };
}

/** @deprecated use resolveActiveWhatsAppProviderName */
export function getConfiguredWhatsAppProviderLabel() {
  return String(config.s7WhatsAppProvider ?? resolveWhatsAppProviderName());
}
