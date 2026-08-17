// =============================================================================
// Resposta normalizada — Fase 3.5C
// =============================================================================

/**
 * @typedef {'sent' | 'failed' | 'blocked' | 'skipped'} ProviderDeliveryStatus
 */

/**
 * @typedef {Object} ProviderResponse
 * @property {ProviderDeliveryStatus} status
 * @property {boolean} ok
 * @property {boolean} [simulated]
 * @property {string} [provider_message_id]
 * @property {string} provider_name
 * @property {string} [error_code]
 * @property {string} [error_message]
 * @property {Record<string, unknown>} [metadata]
 * @property {Record<string, unknown>} [raw]
 */

/**
 * @param {{
 *   ok: boolean;
 *   simulated?: boolean;
 *   provider: string;
 *   providerMessageId?: string | null;
 *   error?: string | null;
 *   blocked?: boolean;
 *   metadata?: Record<string, unknown>;
 *   raw?: Record<string, unknown>;
 * }} input
 * @returns {ProviderResponse}
 */
export function toProviderResponse(input) {
  const errorCode = input.error != null ? String(input.error) : null;
  const blocked = Boolean(input.blocked) || errorCode === "NOT_WHITELISTED";

  /** @type {ProviderDeliveryStatus} */
  let status = "failed";
  if (blocked) status = "blocked";
  else if (input.ok) status = "sent";

  return {
    status,
    ok: Boolean(input.ok),
    simulated: input.simulated,
    provider_message_id: input.providerMessageId ?? undefined,
    provider_name: String(input.provider ?? "unknown"),
    error_code: errorCode ?? undefined,
    error_message: errorCode ?? undefined,
    metadata: input.metadata ?? {},
    raw: input.raw,
  };
}

/**
 * @param {ProviderResponse} response
 */
export function providerResponseToWhatsAppLegacy(response) {
  return {
    ok: response.ok,
    simulated: response.simulated,
    provider: response.provider_name,
    providerMessageId: response.provider_message_id,
    error: response.error_code,
    blocked: response.status === "blocked",
    raw: response.raw,
  };
}
