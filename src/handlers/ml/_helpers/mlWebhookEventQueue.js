/**
 * Política de fila ml_webhook_events — event-first com fairness/recovery.
 *
 * Baseline operacional DEV vendas: 07/08/2026 00:00 America/Sao_Paulo = 2026-08-07T03:00:00Z
 */
export const ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO =
  process.env.ML_WEBHOOK_ORDERS_BASELINE_ISO || "2026-08-07T03:00:00.000Z";

/** @typedef {{ priorityEventIds?: string[] }} MlWebhookFetchOptions */

/**
 * Monta batch com:
 * 1) fast lane — event_ids explícitos (callback recém-persistido)
 * 2) orders_v2 recentes (>= baseline) DESC — baixa latência pós-cutoff
 * 3) orders_v2 recovery (< baseline) ASC — anti-starvation
 * 4) demais tópicos ASC — não bloqueiam vendas (quota residual)
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {number} batchSize
 * @param {MlWebhookFetchOptions} [options]
 */
export async function fetchPendingMlWebhookEvents(supabase, batchSize, options = {}) {
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
    for (const row of fastLane || []) {
      const id = String(row.id || "");
      if (!id || pickedIds.has(id)) continue;
      picked.push(row);
      pickedIds.add(id);
    }
  }

  let remaining = Math.max(0, batchSize - picked.length);
  if (remaining <= 0) return picked;

  const ordersQuota = Math.max(1, Math.ceil(remaining * 0.75));
  const recentQuota = Math.max(1, Math.ceil(ordersQuota * 0.7));
  const recoveryQuota = Math.max(0, ordersQuota - recentQuota);

  if (recentQuota > 0) {
    const { data: recentOrders, error: recentErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .eq("status", "pending")
      .eq("topic", "orders_v2")
      .gte("created_at", ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO)
      .order("created_at", { ascending: false })
      .limit(recentQuota + pickedIds.size);
    if (recentErr) throw recentErr;
    for (const row of recentOrders || []) {
      if (picked.length >= batchSize) break;
      const id = String(row.id || "");
      if (!id || pickedIds.has(id)) continue;
      picked.push(row);
      pickedIds.add(id);
    }
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
    for (const row of recoveryOrders || []) {
      if (picked.length >= batchSize) break;
      const id = String(row.id || "");
      if (!id || pickedIds.has(id)) continue;
      picked.push(row);
      pickedIds.add(id);
    }
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
    for (const row of otherEvents || []) {
      if (picked.length >= batchSize) break;
      const id = String(row.id || "");
      if (!id || pickedIds.has(id)) continue;
      picked.push(row);
      pickedIds.add(id);
    }
  }

  return picked;
}
