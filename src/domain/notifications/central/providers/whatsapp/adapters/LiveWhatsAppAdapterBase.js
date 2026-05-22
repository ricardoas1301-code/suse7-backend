// =============================================================================
// Base live — contrato sem integração HTTP nesta fase (3.5C)
// =============================================================================

import { ProviderAdapter } from "../../abstraction/ProviderAdapter.js";
import { S7_DELIVERY_MODE } from "../../abstraction/deliveryMode.js";
import { LIVE_WHATSAPP_CAPABILITIES } from "../../abstraction/providerCapabilities.js";
import { S7_PROVIDER_CHANNEL } from "../../abstraction/providerChannels.js";
import { toProviderResponse } from "../../abstraction/providerResponse.js";

export class LiveWhatsAppAdapterBase extends ProviderAdapter {
  /**
   * @param {string} providerName
   */
  constructor(providerName) {
    super({
      channel: S7_PROVIDER_CHANNEL.WHATSAPP,
      providerName,
      deliveryMode: S7_DELIVERY_MODE.LIVE,
      capabilities: LIVE_WHATSAPP_CAPABILITIES,
    });
  }

  /** @param {import("../../abstraction/ProviderAdapter.js").ProviderSendInput} input */
  async validate(input) {
    const to = String(input.to ?? "").replace(/\D/g, "");
    if (!to || to.length < 10 || to.length > 15) {
      return { ok: false, error: "INVALID_PHONE" };
    }
    return { ok: true };
  }

  async health() {
    return { ok: false, error: "PROVIDER_NOT_READY", latency_ms: 0 };
  }

  /** @param {import("../../abstraction/ProviderAdapter.js").ProviderSendInput} input */
  async send(input) {
    const validation = await this.validate(input);
    if (!validation.ok) {
      return toProviderResponse({
        ok: false,
        provider: this.providerName,
        error: validation.error ?? "INVALID_PHONE",
      });
    }

    return toProviderResponse({
      ok: false,
      provider: this.providerName,
      error: "PROVIDER_NOT_READY",
      metadata: {
        delivery_mode: S7_DELIVERY_MODE.LIVE,
        note: "Live HTTP integration deferred — adapter contract only (3.5C)",
      },
    });
  }
}
