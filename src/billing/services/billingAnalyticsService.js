// ======================================================================
// Billing Analytics — contratos MRR/ARR/churn (Fase 3.0, sem dashboard)
// ======================================================================

import Decimal from "decimal.js";
import { logBilling } from "../billingLog.js";
import { BILLING_ANALYTICS_METRIC, BILLING_PHASE30_LOG } from "../billingPhase30Constants.js";
import { SUBSCRIPTION_STATUS, DELINQUENCY_STATUS } from "../billingConstants.js";
import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function computePlatformBillingAnalytics(supabase) {
  const { data: subs, error: subsErr } = await supabase
    .from("billing_subscriptions")
    .select("id, user_id, status, amount, currency, metadata, provider")
    .eq("provider", "asaas");
  if (subsErr) throw subsErr;

  let mrr = new Decimal(0);
  let active = 0;
  let grace = 0;
  let suspended = 0;
  let churn = 0;
  let revenueAtRisk = new Decimal(0);

  for (const row of subs ?? []) {
    const status = String(row.status || "").toLowerCase();
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const delinquency = String(meta.delinquency_status ?? "none").toLowerCase();
    const amount = toDecimal(row.amount);

    if (status === SUBSCRIPTION_STATUS.ACTIVE) {
      active += 1;
      if (delinquency === DELINQUENCY_STATUS.NONE) {
        mrr = mrr.plus(amount);
      }
    }
    if (delinquency === DELINQUENCY_STATUS.GRACE) {
      grace += 1;
      revenueAtRisk = revenueAtRisk.plus(amount);
    }
    if (delinquency === DELINQUENCY_STATUS.SUSPENDED || status === SUBSCRIPTION_STATUS.PAST_DUE) {
      suspended += 1;
      revenueAtRisk = revenueAtRisk.plus(amount);
    }
    if (status === SUBSCRIPTION_STATUS.CANCELED) {
      churn += 1;
    }
  }

  const { count: failedPayments } = await supabase
    .from("billing_payments")
    .select("id", { count: "exact", head: true })
    .in("status", ["failed", "overdue"]);

  const mrrCents = mrr.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  const arrCents = mrr.mul(12).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  const atRiskCents = revenueAtRisk.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

  const metrics = {
    [BILLING_ANALYTICS_METRIC.MRR_CENTS]: mrrCents,
    [BILLING_ANALYTICS_METRIC.ARR_CENTS]: arrCents,
    [BILLING_ANALYTICS_METRIC.ACTIVE_SUBSCRIPTIONS]: active,
    [BILLING_ANALYTICS_METRIC.GRACE_SUBSCRIPTIONS]: grace,
    [BILLING_ANALYTICS_METRIC.SUSPENDED_SUBSCRIPTIONS]: suspended,
    [BILLING_ANALYTICS_METRIC.CHURN_COUNT]: churn,
    [BILLING_ANALYTICS_METRIC.FAILED_PAYMENTS]: failedPayments ?? 0,
    [BILLING_ANALYTICS_METRIC.REVENUE_AT_RISK_CENTS]: atRiskCents,
    mrr_display: decimalToScale2String(mrr),
    arr_display: decimalToScale2String(mrr.mul(12)),
    computed_at: new Date().toISOString(),
  };

  logBilling("billing", BILLING_PHASE30_LOG.ANALYTICS_COMPUTED, {
    active_subscriptions: active,
    mrr_cents: mrrCents,
    grace_subscriptions: grace,
    suspended_subscriptions: suspended,
  });

  return metrics;
}

/**
 * Persiste snapshot diário (job/admin futuro).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function persistDailyPlatformAnalyticsSnapshot(supabase) {
  const metrics = await computePlatformBillingAnalytics(supabase);
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const rows = Object.entries(metrics)
    .filter(([key]) => key.endsWith("_cents") || key.endsWith("_subscriptions") || key === "churn_count" || key === "failed_payments")
    .map(([metric_key, metric_value]) => ({
      snapshot_date: snapshotDate,
      metric_key,
      metric_value: Number(metric_value),
      dimensions: {},
    }));

  if (rows.length === 0) return { inserted: 0 };

  const { error } = await supabase.from("billing_analytics_snapshots").upsert(rows, {
    onConflict: "snapshot_date,metric_key,dimensions",
  });
  if (error) throw error;
  return { inserted: rows.length, snapshot_date: snapshotDate };
}
