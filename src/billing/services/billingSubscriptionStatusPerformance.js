// ======================================================================
// DEV — performance log subscription/status (gate operacional)
// ======================================================================

import { logBillingAccessCoalescing } from "./billingAccessGateCache.js";

/**
 * @param {Record<string, unknown>} payload
 */
export function logBillingSubscriptionStatusPerformance(payload) {
  console.info("[S7_BILLING_SUBSCRIPTION_STATUS_PERFORMANCE]", payload);
}

/**
 * @param {string} [prefix]
 */
export function createBillingSubscriptionStatusPerfTracker(prefix = "") {
  const requestId = `${prefix || "bss"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  /** @type {Record<string, number | null>} */
  const marks = {
    auth_validation_ms: null,
    profile_lookup_ms: null,
    subscription_query_ms: null,
    plan_query_ms: null,
    permissions_build_ms: null,
    external_calls_ms: null,
    serialization_ms: null,
  };

  return {
    requestId,
    startedAtIso: new Date(startedAt).toISOString(),
    mark(phase, phaseStartedAt) {
      marks[phase] = Math.max(0, Date.now() - phaseStartedAt);
    },
    finish(extra = {}) {
      const finishedAt = Date.now();
      logBillingSubscriptionStatusPerformance({
        request_id: requestId,
        auth_validation_ms: marks.auth_validation_ms,
        profile_lookup_ms: marks.profile_lookup_ms,
        subscription_query_ms: marks.subscription_query_ms,
        plan_query_ms: marks.plan_query_ms,
        permissions_build_ms: marks.permissions_build_ms,
        external_calls_ms: marks.external_calls_ms,
        serialization_ms: marks.serialization_ms,
        total_ms: finishedAt - startedAt,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
        ...extra,
      });
    },
  };
}

/** @type {Map<string, Promise<unknown>>} */
const inflightByUser = new Map();

/** @type {Map<string, { waiters: number; startedAt: number }>} */
const inflightMetaByUser = new Map();

/** @type {Map<string, { expiresAt: number; payload: Record<string, unknown> }>} */
const statusPayloadCacheByUser = new Map();

const STATUS_PAYLOAD_CACHE_TTL_MS = 25_000;

/**
 * @param {string} userId
 * @returns {Record<string, unknown> | null}
 */
export function getCachedSubscriptionStatusPayload(userId) {
  const key = String(userId || "").trim();
  if (!key) return null;
  const row = statusPayloadCacheByUser.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    statusPayloadCacheByUser.delete(key);
    return null;
  }
  return row.payload;
}

/**
 * @param {string} userId
 * @param {Record<string, unknown>} payload
 */
export function setCachedSubscriptionStatusPayload(userId, payload) {
  const key = String(userId || "").trim();
  if (!key || !payload) return;
  statusPayloadCacheByUser.set(key, {
    expiresAt: Date.now() + STATUS_PAYLOAD_CACHE_TTL_MS,
    payload,
  });
}

/**
 * @param {string} userId
 */
export function invalidateSubscriptionStatusPayloadCache(userId) {
  const key = String(userId || "").trim();
  if (!key) return;
  statusPayloadCacheByUser.delete(key);
}

/**
 * Deduplica status concorrente por user (StrictMode / burst multiaba).
 *
 * @template T
 * @param {string} userId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function dedupeSubscriptionStatusForUser(userId, fn) {
  const key = String(userId || "").trim();
  if (!key) return fn();

  const existing = inflightByUser.get(key);
  if (existing) {
    const meta = inflightMetaByUser.get(key);
    if (meta) meta.waiters += 1;
    logBillingAccessCoalescing({
      user_id: key,
      cache_hit: false,
      inflight_reused: true,
      waiters_count: meta?.waiters ?? 1,
      scope: "subscription_status",
      computation_started_at: meta ? new Date(meta.startedAt).toISOString() : null,
    });
    return /** @type {Promise<T>} */ (existing);
  }

  const startedAt = Date.now();
  inflightMetaByUser.set(key, { waiters: 0, startedAt });

  const run = fn().finally(() => {
    const meta = inflightMetaByUser.get(key);
    logBillingAccessCoalescing({
      user_id: key,
      cache_hit: false,
      inflight_reused: false,
      waiters_count: meta?.waiters ?? 0,
      scope: "subscription_status",
      computation_started_at: new Date(startedAt).toISOString(),
      computation_finished_at: new Date().toISOString(),
      total_ms: Date.now() - startedAt,
    });
    if (inflightByUser.get(key) === run) inflightByUser.delete(key);
    inflightMetaByUser.delete(key);
  });
  inflightByUser.set(key, run);
  return run;
}
