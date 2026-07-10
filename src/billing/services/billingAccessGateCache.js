// ======================================================================
// Cache + coalescing — gate de billing (burst multiaba / thundering herd)
// Janela máxima de consistência: GATE_CACHE_TTL_MS (30s) + invalidação explícita.
// ======================================================================

import { logBillingError } from "../billingLog.js";
import { resolveBillingAccessCore } from "./resolveBillingAccess.js";

/** TTL operacional do cache gate (ms). */
export const BILLING_GATE_CACHE_TTL_MS = 30_000;

/** Janela máxima documentada de consistência antes de invalidação por TTL. */
export const BILLING_GATE_CACHE_MAX_CONSISTENCY_MS = 45_000;

/**
 * @param {Record<string, unknown>} billing
 */
function buildBillingGateVersionKey(billing) {
  const access =
    billing?.access && typeof billing.access === "object"
      ? /** @type {Record<string, unknown>} */ (billing.access)
      : {};
  return [
    access.subscription_id ?? "none",
    access.plan_id ?? "none",
    access.subscription_status ?? "none",
    access.state ?? "none",
    Boolean(billing?.can_access),
  ].join(":");
}

/** @type {Map<string, { expiresAt: number; versionKey: string; value: Record<string, unknown> }>} */
const gateCache = new Map();

/** @type {Map<string, { promise: Promise<Record<string, unknown>>; waiters: number; startedAt: number }>} */
const gateInflight = new Map();

/**
 * @param {Record<string, unknown>} payload
 */
export function logBillingAccessCoalescing(payload) {
  console.info("[S7_BILLING_ACCESS_COALESCING]", payload);
}

/**
 * @param {string} userId
 */
export function invalidateBillingAccessGateCache(userId) {
  const id = String(userId || "").trim();
  if (!id) return;
  for (const key of gateCache.keys()) {
    if (key.startsWith(`gate:${id}:`)) gateCache.delete(key);
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ module?: string | null }} [options]
 */
export async function resolveBillingAccessGateCached(supabase, userId, options = {}) {
  const id = String(userId || "").trim();
  if (!id) {
    return resolveBillingAccessCore(supabase, userId, { ...options, usageScope: "gate", ensureBaby: false });
  }

  const prefix = `gate:${id}:`;
  const now = Date.now();
  for (const [key, row] of gateCache.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (row.expiresAt > now) {
      logBillingAccessCoalescing({
        user_id: id,
        cache_hit: true,
        inflight_reused: false,
        waiters_count: 0,
        version_key: row.versionKey,
        total_ms: 0,
      });
      return row.value;
    }
    gateCache.delete(key);
  }

  const inflight = gateInflight.get(id);
  if (inflight) {
    inflight.waiters += 1;
    logBillingAccessCoalescing({
      user_id: id,
      cache_hit: false,
      inflight_reused: true,
      waiters_count: inflight.waiters,
      computation_started_at: new Date(inflight.startedAt).toISOString(),
    });
    return inflight.promise;
  }

  const computationStartedAt = Date.now();
  logBillingAccessCoalescing({
    user_id: id,
    cache_hit: false,
    inflight_reused: false,
    waiters_count: 0,
    computation_started_at: new Date(computationStartedAt).toISOString(),
  });

  const run = (async () => {
    try {
      return await resolveBillingAccessCore(supabase, id, {
        ...options,
        usageScope: "gate",
        ensureBaby: false,
      });
    } catch (error) {
      logBillingError("billing", "gate_cache_resolve_failed", error, { user_id: id });
      throw error;
    }
  })();

  gateInflight.set(id, { promise: run, waiters: 0, startedAt: computationStartedAt });

  try {
    const value = await run;
    const versionKey = buildBillingGateVersionKey(value);
    gateCache.set(`${prefix}${versionKey}`, {
      expiresAt: Date.now() + BILLING_GATE_CACHE_TTL_MS,
      versionKey,
      value,
    });
    return value;
  } finally {
    const entry = gateInflight.get(id);
    logBillingAccessCoalescing({
      user_id: id,
      cache_hit: false,
      inflight_reused: false,
      waiters_count: entry?.waiters ?? 0,
      computation_started_at: new Date(computationStartedAt).toISOString(),
      computation_finished_at: new Date().toISOString(),
      total_ms: Date.now() - computationStartedAt,
    });
    if (gateInflight.get(id)?.promise === run) gateInflight.delete(id);
  }
}
