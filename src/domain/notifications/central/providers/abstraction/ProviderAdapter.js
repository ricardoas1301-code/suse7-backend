// =============================================================================
// Contrato ProviderAdapter — Fase 3.5C
// =============================================================================

/**
 * @typedef {Object} ProviderSendInput
 * @property {string} to
 * @property {string} message
 * @property {string} [subject]
 * @property {Record<string, unknown>} [metadata]
 * @property {string} [dispatch_id]
 * @property {number} [attempt]
 */

/**
 * @typedef {import("./providerResponse.js").ProviderResponse} ProviderResponse
 * @typedef {import("./providerCapabilities.js").ProviderCapabilities} ProviderCapabilities
 * @typedef {import("./deliveryMode.js").DeliveryMode} DeliveryMode
 */

export class ProviderAdapter {
  /**
   * @param {{
   *   channel: string;
   *   providerName: string;
   *   deliveryMode: DeliveryMode;
   *   capabilities: ProviderCapabilities;
   * }} spec
   */
  constructor(spec) {
    this.channel = spec.channel;
    this.providerName = spec.providerName;
    this.deliveryMode = spec.deliveryMode;
    this.capabilities = spec.capabilities;
  }

  getCapabilities() {
    return this.capabilities;
  }

  /**
   * @param {ProviderSendInput} _input
   * @returns {Promise<{ ok: boolean; error?: string }>}
   */
  async validate(_input) {
    return { ok: true };
  }

  /**
   * @returns {Promise<{ ok: boolean; latency_ms?: number; error?: string }>}
   */
  async health() {
    return { ok: true, latency_ms: 0 };
  }

  /**
   * @param {ProviderSendInput} _input
   * @returns {Promise<ProviderResponse>}
   */
  async send(_input) {
    throw new Error("PROVIDER_SEND_NOT_IMPLEMENTED");
  }
}
