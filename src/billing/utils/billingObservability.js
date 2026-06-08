// ======================================================================
// Observabilidade estruturada — billing (sem secrets)
// ======================================================================

import { sanitizeBillingAuditValue } from "./billingAuditSanitize.js";

const ALLOWED_FIELDS = new Set([
  "source",
  "action",
  "status",
  "duration_ms",
  "user_id",
  "subscription_id",
  "payment_id",
  "renewal_cycle_id",
  "provider_event_id",
  "correlation_id",
  "request_id",
  "event_type",
  "timeline_event_id",
  "dispatch_id",
  "health_level",
  "count",
  "issues_count",
  "job",
  "reason",
  "processed",
  "duplicate",
  "warning",
  "check",
  "severity",
  "open_cycles_count",
  "canonical_cycle_id",
  "superseded_count",
  "subscriptions_with_duplicates",
  "open_cycles_scanned",
  "reconciled_subscriptions",
  "checks_run_at",
  "issues_count",
  "kind",
  "supported",
  "duplicate",
]);

/**
 * @param {Record<string, unknown>} input
 */
export function buildBillingObservabilityContext(input = {}) {
  /** @type {Record<string, unknown>} */
  const ctx = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value == null || value === "") continue;
    ctx[key] = typeof value === "string" ? value.slice(0, 512) : value;
  }
  return sanitizeBillingAuditValue(ctx);
}

/**
 * @param {() => Promise<T>} fn
 * @param {Record<string, unknown>} ctx
 * @returns {Promise<{ result: T; duration_ms: number }>}
 * @template T
 */
export async function withBillingTiming(fn, ctx = {}) {
  const started = Date.now();
  const result = await fn();
  return { result, duration_ms: Date.now() - started, context: buildBillingObservabilityContext(ctx) };
}
