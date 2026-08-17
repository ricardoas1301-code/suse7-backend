// =============================================================================
// Observabilidade provider — Fase 3.5C (sem segredos)
// =============================================================================

const PREFIX = "[S7_PROVIDER]";

/**
 * @param {string | null | undefined} phoneDigits
 */
export function maskPhoneForProviderLog(phoneDigits) {
  const d = String(phoneDigits ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, d.length - 4))}${d.slice(-4)}`;
}

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} payload
 */
export function logProviderDelivery(eventSuffix, payload = {}) {
  const safe = { ...payload };
  for (const key of ["token", "api_key", "secret", "password", "authorization"]) {
    if (key in safe) delete safe[key];
  }
  if (safe.to != null) {
    safe.to_masked = maskPhoneForProviderLog(String(safe.to));
    delete safe.to;
  }
  console.info(`${PREFIX}_${eventSuffix}`, safe);
}

/**
 * @param {Record<string, unknown>} entry
 */
export function logProviderStart(entry) {
  logProviderDelivery("START", entry);
}

/**
 * @param {Record<string, unknown>} entry
 */
export function logProviderSuccess(entry) {
  logProviderDelivery("SUCCESS", entry);
}

/**
 * @param {Record<string, unknown>} entry
 */
export function logProviderFail(entry) {
  logProviderDelivery("FAIL", entry);
}

/**
 * @param {Record<string, unknown>} entry
 */
export function logProviderBlocked(entry) {
  logProviderDelivery("BLOCKED", entry);
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
