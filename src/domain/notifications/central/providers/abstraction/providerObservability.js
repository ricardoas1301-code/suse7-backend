// =============================================================================
// Observabilidade provider — Fase 3.5C (sem segredos)
// =============================================================================

const PREFIX = "[S7_PROVIDER]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} payload
 */
export function logProviderDelivery(eventSuffix, payload = {}) {
  const safe = { ...payload };
  for (const key of ["token", "api_key", "secret", "password", "authorization"]) {
    if (key in safe) delete safe[key];
  }
  console.info(`${PREFIX}_${eventSuffix}`, safe);
}

/**
 * @param {{
 *   channel: string;
 *   provider_name: string;
 *   delivery_mode: string;
 *   dispatch_id?: string | null;
 *   attempt?: number;
 *   duration_ms: number;
 *   ok: boolean;
 *   error_code?: string | null;
 *   error_message?: string | null;
 *   simulated?: boolean;
 * }} entry
 */
export function logProviderSendOutcome(entry) {
  logProviderDelivery(entry.ok ? "SEND_OK" : "SEND_FAIL", {
    channel: entry.channel,
    provider_name: entry.provider_name,
    delivery_mode: entry.delivery_mode,
    dispatch_id: entry.dispatch_id ?? null,
    attempt: entry.attempt ?? 1,
    duration_ms: entry.duration_ms,
    error_code: entry.error_code ?? null,
    error_message: entry.error_message ?? null,
    simulated: Boolean(entry.simulated),
  });
}
