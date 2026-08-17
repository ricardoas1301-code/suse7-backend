/**
 * Contrato de retry para ml_webhook_events — erros transitórios vs definitivos.
 */

/** @param {number} attempts */
export function calcMlWebhookRetryBackoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(15 * 60 * 1000, 30_000 * 2 ** Math.min(n - 1, 5));
}

/**
 * @param {string | null | undefined} message
 * @param {string | null | undefined} code
 */
export function isMlWebhookTransientError(message, code) {
  const c = String(code || "").trim().toUpperCase();
  const m = String(message || "").toLowerCase();
  if (c === "WEBHOOK_ACCOUNT_AMBIGUOUS" || c === "WEBHOOK_ACCOUNT_CONTEXT_NOT_FOUND") return false;
  if (m.includes("webhook_account_ambiguous") || m.includes("account_ambiguous")) return false;
  if (m.includes("invalid_order_id")) return false;
  if (m.includes("ml_client_id ou ml_client_secret ausentes")) return true;
  if (m.includes("tokens não encontrados")) return true;
  if (m.includes("token") && (m.includes("expir") || m.includes("refresh"))) return true;
  if (m.includes("timeout") || m.includes("econnreset") || m.includes("fetch failed")) return true;
  if (m.includes("429") || m.includes("503") || m.includes("502")) return true;
  return c === "WEBHOOK_PROCESS_ERROR" || c === "";
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} maxAttempts
 * @param {number} [nowMs]
 */
export function isMlWebhookEventRetryDue(row, maxAttempts, nowMs = Date.now()) {
  const status = String(row.status || "").toLowerCase();
  if (status !== "pending" && status !== "error") return false;
  const attempts = Number(row.attempts || 0);
  if (attempts <= 0 || attempts >= maxAttempts) return false;
  const msg = row.last_error_message ?? row.error_message ?? null;
  const code = row.last_error_code ?? null;
  if (!isMlWebhookTransientError(msg != null ? String(msg) : null, code != null ? String(code) : null)) {
    return false;
  }
  const updatedAt = row.updated_at != null ? Date.parse(String(row.updated_at)) : NaN;
  if (!Number.isFinite(updatedAt)) return true;
  return nowMs >= updatedAt + calcMlWebhookRetryBackoffMs(attempts);
}

/**
 * Evento orders_v2 registrado há tempo sem nenhuma tentativa — risco de starvation no backlog.
 *
 * @param {Record<string, unknown>} row
 * @param {number} [nowMs]
 */
export function isMlWebhookStalePendingEvent(row, nowMs = Date.now()) {
  if (String(row.status || "").toLowerCase() !== "pending") return false;
  if (Number(row.attempts || 0) > 0) return false;
  const createdAt = row.created_at != null ? Date.parse(String(row.created_at)) : NaN;
  if (!Number.isFinite(createdAt)) return false;
  const staleMs = Math.max(60_000, parseInt(process.env.ML_WEBHOOK_STALE_PENDING_MS || "300000", 10) || 300_000);
  return nowMs - createdAt >= staleMs;
}
