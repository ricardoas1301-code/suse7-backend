// ======================================================================
// Invalidação canônica — gate + payload status (fail-closed, sem stale longo)
// ======================================================================

import { invalidateBillingAccessGateCache } from "./billingAccessGateCache.js";
import { invalidateSubscriptionStatusPayloadCache } from "./billingSubscriptionStatusPerformance.js";

/**
 * @param {string | null | undefined} userId
 * @param {{ reason?: string }} [meta]
 */
export function invalidateBillingAccessCachesForUser(userId, meta = {}) {
  const id = String(userId || "").trim();
  if (!id) return;
  invalidateBillingAccessGateCache(id);
  invalidateSubscriptionStatusPayloadCache(id);
  if (process.env.NODE_ENV !== "production") {
    console.info("[S7_BILLING_ACCESS_CACHE_INVALIDATED]", {
      user_id: id,
      reason: meta.reason ?? "unspecified",
    });
  }
}
