// =============================================================================
// Adapter sandbox (3.5B policy + mock runtime) — Fase 3.5C
// =============================================================================

import { ProviderAdapter } from "../../abstraction/ProviderAdapter.js";
import { S7_DELIVERY_MODE } from "../../abstraction/deliveryMode.js";
import { SANDBOX_WHATSAPP_CAPABILITIES } from "../../abstraction/providerCapabilities.js";
import { S7_PROVIDER_CHANNEL } from "../../abstraction/providerChannels.js";
import { toProviderResponse } from "../../abstraction/providerResponse.js";

export class SandboxWhatsAppAdapter extends ProviderAdapter {
  constructor() {
    super({
      channel: S7_PROVIDER_CHANNEL.WHATSAPP,
      providerName: "sandbox_mock",
      deliveryMode: S7_DELIVERY_MODE.SANDBOX,
      capabilities: SANDBOX_WHATSAPP_CAPABILITIES,
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

    const mockId = `s7_whatsapp_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return toProviderResponse({
      ok: true,
      simulated: true,
      provider: this.providerName,
      providerMessageId: mockId,
      raw: { mock: true, sandbox: true },
      metadata: { delivery_mode: S7_DELIVERY_MODE.SANDBOX },
    });
  }
}
