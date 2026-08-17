// ======================================================================
// Consistency checks — billing (job / suporte)
// ======================================================================

import { RENEWAL_CYCLE_OPEN_STATUSES } from "../billingConstants.js";
import { logBilling } from "../billingLog.js";
import { buildBillingObservabilityContext } from "../utils/billingObservability.js";
import { reconcileOpenRenewalCyclesForSubscription } from "./billingRenewalCycleConsistencyService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ limit?: number; autoReconcileOpenCycles?: boolean }} [options]
 */
export async function runBillingConsistencyChecks(supabase, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 500;
  const started = Date.now();

  /** @type {Array<Record<string, unknown>>} */
  const issues = [];

  const { data: openCycles, error: openErr } = await supabase
    .from("billing_renewal_cycles")
    .select("id, subscription_id, user_id, renewal_status, created_at")
    .in("renewal_status", [...RENEWAL_CYCLE_OPEN_STATUSES])
    .order("created_at", { ascending: false })
    .limit(limit * 5);

  if (openErr) throw openErr;

  /** @type {Map<string, typeof openCycles>} */
  const bySubscription = new Map();
  for (const row of openCycles ?? []) {
    const subId = String(row.subscription_id);
    if (!bySubscription.has(subId)) bySubscription.set(subId, []);
    bySubscription.get(subId)?.push(row);
  }

  /** @type {string[]} */
  const reconciledSubscriptions = [];

  for (const [subscriptionId, cycles] of bySubscription.entries()) {
    if (cycles.length <= 1) continue;
    issues.push({
      check: "multiple_open_renewal_cycles",
      severity: "warning",
      subscription_id: subscriptionId,
      count: cycles.length,
      cycle_ids: cycles.map((c) => c.id),
    });
    if (options.autoReconcileOpenCycles) {
      const result = await reconcileOpenRenewalCyclesForSubscription(supabase, subscriptionId, {
        reason: "consistency_check_job",
      });
      reconciledSubscriptions.push(subscriptionId);
      if (result.supersededCycleIds?.length) {
        issues.push({
          check: "multiple_open_renewal_cycles_reconciled",
          severity: "info",
          subscription_id: subscriptionId,
          superseded_count: result.supersededCycleIds.length,
          canonical_cycle_id: result.canonicalCycle?.id ?? null,
        });
      }
    }
  }

  const { data: orphanPayments, error: payErr } = await supabase
    .from("billing_payments")
    .select("id, user_id, subscription_id, provider_payment_id, status, created_at")
    .is("subscription_id", null)
    .eq("provider", "asaas")
    .order("created_at", { ascending: false })
    .limit(50);

  if (payErr) throw payErr;

  for (const pay of orphanPayments ?? []) {
    issues.push({
      check: "orphan_payment_without_subscription",
      severity: "warning",
      payment_id: pay.id,
      user_id: pay.user_id,
      provider_payment_id: pay.provider_payment_id,
      status: pay.status,
    });
  }

  const { data: timelineOrphans, error: tlErr } = await supabase
    .from("billing_timeline_events")
    .select("id, user_id, subscription_id, event_type, occurred_at")
    .not("subscription_id", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(100);

  if (tlErr) throw tlErr;

  const subIds = [...new Set((timelineOrphans ?? []).map((r) => String(r.subscription_id)).filter(Boolean))];
  if (subIds.length > 0) {
    const { data: subs } = await supabase.from("billing_subscriptions").select("id").in("id", subIds.slice(0, 100));
    const valid = new Set((subs ?? []).map((s) => String(s.id)));
    for (const row of timelineOrphans ?? []) {
      if (row.subscription_id && !valid.has(String(row.subscription_id))) {
        issues.push({
          check: "timeline_subscription_missing",
          severity: "warning",
          timeline_event_id: row.id,
          subscription_id: row.subscription_id,
          user_id: row.user_id,
        });
      }
    }
  }

  const { data: notifyRows, error: nErr } = await supabase
    .from("billing_notification_dispatches")
    .select("id, user_id, template_key, created_at")
    .is("user_id", null)
    .limit(20);

  if (nErr) throw nErr;

  for (const row of notifyRows ?? []) {
    issues.push({
      check: "notification_without_user",
      severity: "warning",
      dispatch_id: row.id,
      template_key: row.template_key,
    });
  }

  const duration_ms = Date.now() - started;
  const summary = {
    ok: issues.filter((i) => i.severity === "critical" || i.severity === "danger").length === 0,
    issues_count: issues.length,
    open_cycles_scanned: openCycles?.length ?? 0,
    subscriptions_with_duplicates: [...bySubscription.entries()].filter(([, c]) => c.length > 1).length,
    reconciled_subscriptions: reconciledSubscriptions.length,
    duration_ms,
    checks_run_at: new Date().toISOString(),
  };

  logBilling("billing", "S7_BILLING_CONSISTENCY_CHECK_DONE", {
    ...buildBillingObservabilityContext({
      ...summary,
      source: "billing_consistency_check",
    }),
  });

  return { summary, issues };
}
