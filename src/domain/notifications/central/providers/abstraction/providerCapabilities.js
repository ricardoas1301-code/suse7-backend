// =============================================================================
// Capacidades por provider — Fase 3.5C
// =============================================================================

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} supports_media
 * @property {boolean} supports_template
 * @property {boolean} supports_batch
 * @property {boolean} supports_delivery_receipt
 * @property {boolean} supports_retry
 */

/** @type {ProviderCapabilities} */
export const MOCK_WHATSAPP_CAPABILITIES = Object.freeze({
  supports_media: false,
  supports_template: false,
  supports_batch: false,
  supports_delivery_receipt: false,
  supports_retry: true,
});

/** @type {ProviderCapabilities} */
export const SANDBOX_WHATSAPP_CAPABILITIES = Object.freeze({
  ...MOCK_WHATSAPP_CAPABILITIES,
});

/** @type {ProviderCapabilities} */
export const LIVE_WHATSAPP_CAPABILITIES = Object.freeze({
  supports_media: true,
  supports_template: true,
  supports_batch: false,
  supports_delivery_receipt: true,
  supports_retry: true,
});

/**
 * @param {Partial<ProviderCapabilities>} partial
 * @returns {ProviderCapabilities}
 */
export function defineProviderCapabilities(partial = {}) {
  return {
    supports_media: Boolean(partial.supports_media),
    supports_template: Boolean(partial.supports_template),
    supports_batch: Boolean(partial.supports_batch),
    supports_delivery_receipt: Boolean(partial.supports_delivery_receipt),
    supports_retry: partial.supports_retry !== false,
  };
}
