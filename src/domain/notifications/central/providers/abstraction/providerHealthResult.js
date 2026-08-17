// =============================================================================
// ProviderHealthResult — Fase 3.5C.1
// =============================================================================

/**
 * @typedef {'ok' | 'degraded' | 'down'} ProviderHealthStatus
 */

/**
 * @typedef {Object} ProviderHealthResult
 * @property {string} provider
 * @property {ProviderHealthStatus} status
 * @property {number} latency_ms
 * @property {string} timestamp
 * @property {string} [error_code]
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * @param {{
 *   provider: string;
 *   ok: boolean;
 *   latency_ms: number;
 *   error_code?: string | null;
 *   metadata?: Record<string, unknown>;
 * }} input
 * @returns {ProviderHealthResult}
 */
export function buildProviderHealthResult(input) {
  /** @type {ProviderHealthStatus} */
  const status = input.ok ? "ok" : input.error_code === "PROVIDER_UNAVAILABLE" ? "down" : "degraded";

  return {
    provider: String(input.provider ?? "unknown"),
    status,
    latency_ms: Math.max(0, Number(input.latency_ms) || 0),
    timestamp: new Date().toISOString(),
    error_code: input.error_code ?? undefined,
    metadata: input.metadata ?? {},
  };
}
