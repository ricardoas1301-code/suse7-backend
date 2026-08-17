// =============================================================================
// ZapiWhatsAppProvider — implementação live Z-API (Fase 3.5C.1.A1)
// =============================================================================

import { WhatsAppProviderStrategy } from "./WhatsAppProviderStrategy.js";
import { ZapiWhatsAppAdapter } from "./adapters/ZapiWhatsAppAdapter.js";

/**
 * Provider Z-API. HTTP isolado em zapiHttpClient (sem chamadas diretas no motor).
 */
export class ZapiWhatsAppProvider extends WhatsAppProviderStrategy {
  constructor() {
    super({
      channel: "whatsapp",
      providerName: "zapi",
      deliveryMode: "live",
      capabilities: new ZapiWhatsAppAdapter().getCapabilities(),
    });
    /** @private */
    this._delegate = new ZapiWhatsAppAdapter();
  }

  /** @param {import("../abstraction/ProviderAdapter.js").ProviderSendInput} input */
  validate(input) {
    return this._delegate.validate(input);
  }

  health() {
    return this._delegate.health();
  }

  /** @param {import("../abstraction/ProviderAdapter.js").ProviderSendInput} input */
  send(input) {
    return this._delegate.send(input);
  }
}
