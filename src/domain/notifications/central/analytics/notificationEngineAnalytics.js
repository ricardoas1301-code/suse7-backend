// =============================================================================
// Analytics / observabilidade — base DevCenter (Fase 3.1)
// =============================================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ sellerId?: string | null; hours?: number }} [options]
 */
export async function getCentralNotificationEngineSummary(supabase, options = {}) {
  const hours = Number.isFinite(Number(options.hours)) ? Math.max(1, Math.min(168, Number(options.hours))) : 24;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  let eventsQ = supabase
    .from("s7_notification_events")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);

  let dispatchesQ = supabase
    .from("s7_notification_dispatches")
    .select("status", { count: "exact" })
    .gte("created_at", since);

  if (options.sellerId) {
    eventsQ = eventsQ.eq("seller_id", options.sellerId);
    dispatchesQ = dispatchesQ.eq("seller_id", options.sellerId);
  }

  const [{ count: eventsCount, error: evErr }, { data: dispatchRows, error: dispErr }] = await Promise.all([
    eventsQ,
    dispatchesQ,
  ]);

  if (evErr) throw evErr;
  if (dispErr) throw dispErr;

  /** @type {Record<string, number>} */
  const byStatus = {};
  for (const row of dispatchRows ?? []) {
    const st = row.status != null ? String(row.status) : "UNKNOWN";
    byStatus[st] = (byStatus[st] ?? 0) + 1;
  }

  const totalDispatches = Object.values(byStatus).reduce((a, b) => a + b, 0);

  return {
    window_hours: hours,
    since,
    events_count: eventsCount ?? 0,
    dispatches_total: totalDispatches,
    dispatches_by_status: byStatus,
    engine: "s7_central_notification_engine",
    phase: "3.1",
  };
}
