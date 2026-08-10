/**
 * Política de fila ml_webhook_events — event-first com fairness/recovery/retry.
 */
import {
  isMlWebhookEventRetryDue,
  isMlWebhookStalePendingEvent,
} from "./mlWebhookRetry.js";

export const ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO =
  process.env.ML_WEBHOOK_ORDERS_BASELINE_ISO || "2026-08-07T03:00:00.000Z";

/** @typedef {{ priorityEventIds?: string[]; maxAttempts?: number }} MlWebhookFetchOptions */

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Set<string>} pickedIds
 * @param {number} batchSize
 * @param {Record<string, unknown>[]} picked
 */
function appendUniqueRows(rows, pickedIds, batchSize, picked) {
  for (const row of rows || []) {
    if (picked.length >= batchSize) break;
    const id = String(row.id || "");
    if (!id || pickedIds.has(id)) continue;
    picked.push(row);
    pickedIds.add(id);
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {number} batchSize
 * @param {MlWebhookFetchOptions} [options]
 */
export async function fetchPendingMlWebhookEvents(supabase, batchSize, options = {}) {
  const maxAttempts = Math.max(1, parseInt(String(options.maxAttempts ?? "5"), 10) || 5);
  const priorityEventIds = (Array.isArray(options.priorityEventIds) ? options.priorityEventIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .slice(0, batchSize);

  /** @type {Record<string, unknown>[]} */
  const picked = [];
  const pickedIds = new Set();

  if (priorityEventIds.length > 0) {
    const { data: fastLane, error: fastErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .in("id", priorityEventIds)
      .in("status", ["pending", "error"]);
    if (fastErr) throw fastErr;
    appendUniqueRows(fastLane, pickedIds, batchSize, picked);
  }

  let remaining = Math.max(0, batchSize - picked.length);
  if (remaining <= 0) return picked;

  const ordersQuota = Math.max(1, Math.ceil(remaining * 0.75));
  const retryQuota = Math.max(1, Math.ceil(ordersQuota * 0.2));
  const staleQuota = Math.max(1, Math.ceil(ordersQuota * 0.15));
  const recentQuota = Math.max(1, Math.ceil(ordersQuota * 0.5));
  const recoveryQuota = Math.max(0, ordersQuota - retryQuota - staleQuota - recentQuota);

  if (retryQuota > 0) {
    const { data: retryCandidates, error: retryErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .eq("topic", "orders_v2")
      .in("status", ["pending", "error"])
      .gt("attempts", 0)
      .lt("attempts", maxAttempts)
      .order("updated_at", { ascending: true })
      .limit(retryQuota * 8);
    if (retryErr) throw retryErr;
    const due = (retryCandidates || []).filter((row) => isMlWebhookEventRetryDue(row, maxAttempts));
    appendUniqueRows(due.slice(0, retryQuota), pickedIds, batchSize, picked);
  }

  remaining = Math.max(0, batchSize - picked.length);
  const effectiveStale = Math.min(staleQuota, remaining);
  if (effectiveStale > 0) {
    const staleCutoff = new Date(Date.now() - 300_000).toISOString();
    const { data: staleCandidates, error: staleErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .eq("status", "pending")
      .eq("topic", "orders_v2")
      .eq("attempts", 0)
      .lt("created_at", staleCutoff)
      .order("created_at", { ascending: true })
      .limit(effectiveStale + pickedIds.size);
    if (staleErr) throw staleErr;
    const stale = (staleCandidates || []).filter((row) => isMlWebhookStalePendingEvent(row));
    appendUniqueRows(stale, pickedIds, batchSize, picked);
  }

  remaining = Math.max(0, batchSize - picked.length);
  const effectiveRecent = Math.min(recentQuota, remaining);
  if (effectiveRecent > 0) {
    const { data: recentOrders, error: recentErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .eq("status", "pending")
      .eq("topic", "orders_v2")
      .gte("created_at", ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO)
      .order("created_at", { ascending: false })
      .limit(effectiveRecent + pickedIds.size);
    if (recentErr) throw recentErr;
    appendUniqueRows(recentOrders, pickedIds, batchSize, picked);
  }

  remaining = Math.max(0, batchSize - picked.length);
  const effectiveRecovery = Math.min(recoveryQuota, remaining);
  if (effectiveRecovery > 0) {
    const { data: recoveryOrders, error: recoveryErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .eq("status", "pending")
      .eq("topic", "orders_v2")
      .lt("created_at", ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO)
      .order("created_at", { ascending: true })
      .limit(effectiveRecovery + pickedIds.size);
    if (recoveryErr) throw recoveryErr;
    appendUniqueRows(recoveryOrders, pickedIds, batchSize, picked);
  }

  remaining = Math.max(0, batchSize - picked.length);
  if (remaining > 0) {
    const { data: otherEvents, error: otherErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .eq("status", "pending")
      .neq("topic", "orders_v2")
      .order("created_at", { ascending: true })
      .limit(remaining + pickedIds.size);
    if (otherErr) throw otherErr;
    appendUniqueRows(otherEvents, pickedIds, batchSize, picked);
  }

  return picked;
}
