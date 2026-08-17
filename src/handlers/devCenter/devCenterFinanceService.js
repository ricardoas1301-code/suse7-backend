// ======================================================
// Dev Center — Financeiro operacional (Fase 3)
// Central financeira SaaS — agrega billing platform-wide.
// ======================================================

import {
  buildDevCenterSubscriptionDetail,
  buildDevCenterSubscriptionsList,
} from "./devCenterSubscriptionsService.js";

/**
 * @param {unknown} status
 */
function normalizePaymentStatus(status) {
  const raw = String(status ?? "").trim().toLowerCase();
  if (!raw) return "pending";
  if (["received", "confirmed", "received_in_cash", "paid", "pago"].includes(raw)) return "paid";
  if (["pending", "pendente", "awaiting_payment"].includes(raw)) return "pending";
  if (["overdue", "vencido", "past_due"].includes(raw)) return "overdue";
  if (["refunded", "estornado", "refund"].includes(raw)) return "refunded";
  if (["canceled", "cancelled", "deleted", "cancelado"].includes(raw)) return "canceled";
  if (["failed", "falhou", "chargeback"].includes(raw)) return "failed";
  return raw;
}

/**
 * @param {unknown} amount
 */
function amountToCents(amount) {
  if (amount == null || amount === "") return 0;
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * @param {number} cents
 */
function formatBrlFromCents(cents) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} traceId
 */
async function loadAllPayments(supabase, traceId) {
  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, user_id, subscription_id, status, amount, paid_at, created_at, raw_payload")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) {
    console.warn("[dev-center-finance] payments_failed", { message: error.message, traceId });
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * @param {Record<string, unknown>[]} payments
 */
function latestPaymentBySubscription(payments) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  for (const p of payments) {
    const sid = p.subscription_id != null ? String(p.subscription_id) : "";
    if (!sid || map.has(sid)) continue;
    map.set(sid, p);
  }
  return map;
}

/**
 * @param {Record<string, unknown>} payment
 */
function paymentMethodFromRow(payment) {
  const payload = payment?.raw_payload && typeof payment.raw_payload === "object" ? payment.raw_payload : {};
  const method = payload.billingType ?? payload.paymentMethod ?? null;
  const m = String(method ?? "").trim().toUpperCase();
  if (!m) return "—";
  if (m.includes("CREDIT") || m === "CARD") return "Cartão";
  if (m.includes("PIX")) return "Pix";
  if (m.includes("BOLETO")) return "Boleto";
  return m;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} traceId
 */
export async function buildDevCenterFinanceList(supabase, traceId) {
  const subPayload = await buildDevCenterSubscriptionsList(supabase, traceId);
  const payments = await loadAllPayments(supabase, traceId);
  const paymentBySub = latestPaymentBySubscription(payments);

  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const days30 = Date.now() - 30 * 86400000;

  let receivedMonthCents = 0;
  let receivedTotalCents = 0;
  let pendingCents = 0;
  let failed30d = 0;
  let paidCount = 0;
  let paidSumCents = 0;

  for (const p of payments) {
    const st = normalizePaymentStatus(p.status);
    const cents = amountToCents(p.amount);
    const paidAt = p.paid_at ?? p.created_at;
    const paidMs = paidAt ? new Date(String(paidAt)).getTime() : 0;

    if (st === "paid") {
      receivedTotalCents += cents;
      if (paidMs >= monthStart) receivedMonthCents += cents;
      paidCount += 1;
      paidSumCents += cents;
    }
    if (st === "pending" || st === "overdue") pendingCents += cents;
    if ((st === "failed" || st === "overdue") && paidMs >= days30) failed30d += 1;
  }

  let graceMrrCents = 0;
  let riskMrrCents = 0;
  let canceledCount = 0;
  let payingSellers = 0;
  /** @type {Map<string, number>} */
  const mrrByPlan = new Map();

  /** @type {Record<string, unknown>[]} */
  const rows = (subPayload.subscriptions ?? []).map((row) => {
    const payment = paymentBySub.get(String(row.id));
    const paymentStatus = payment ? normalizePaymentStatus(payment.status) : "—";
    const paymentMethod = payment ? paymentMethodFromRow(payment) : row.payment_method ?? "—";
    const lastChargeAt = payment?.paid_at ?? payment?.created_at ?? null;
    const lastChargeCents = payment ? amountToCents(payment.amount) : 0;

    const billingStatus = String(row.billing_status ?? "");
    const mrrCents = Number(row.amount_cents ?? 0);

    if (billingStatus === "grace") graceMrrCents += mrrCents;
    if (billingStatus === "past_due" || billingStatus === "paused" || row.financial_health === "risco_churn") {
      riskMrrCents += mrrCents;
    }
    if (billingStatus === "canceled") canceledCount += 1;
    if (billingStatus === "active" && mrrCents > 0) payingSellers += 1;

    const planKey = String(row.plan ?? "—");
    if (billingStatus === "active" && mrrCents > 0) {
      mrrByPlan.set(planKey, (mrrByPlan.get(planKey) ?? 0) + mrrCents);
    }

    return {
      ...row,
      payment_status: paymentStatus,
      payment_method: paymentMethod,
      last_charge_at: lastChargeAt,
      last_charge_brl: lastChargeCents > 0 ? formatBrlFromCents(lastChargeCents) : "—",
      mrr_brl: mrrCents > 0 ? formatBrlFromCents(mrrCents) : row.amount_brl ?? "—",
    };
  });

  const mrrCents = rows
    .filter((r) => String(r.billing_status) === "active")
    .reduce((acc, r) => acc + Number(r.amount_cents ?? 0), 0);

  let topPlan = { plan: "—", mrr_brl: "—", share_percent: 0 };
  let topPlanCents = 0;
  for (const [plan, cents] of mrrByPlan.entries()) {
    if (cents > topPlanCents) {
      topPlanCents = cents;
      topPlan = {
        plan,
        mrr_brl: formatBrlFromCents(cents),
        share_percent: mrrCents > 0 ? Math.round((cents / mrrCents) * 100) : 0,
      };
    }
  }

  const criticalSellers = rows.filter(
    (r) => r.financial_health === "inadimplente" || r.financial_health === "risco_churn",
  ).length;

  const summary = {
    mrr_brl: formatBrlFromCents(mrrCents),
    arr_brl: formatBrlFromCents(mrrCents * 12),
    receita_mes_atual_brl: formatBrlFromCents(receivedMonthCents),
    receita_recebida_brl: formatBrlFromCents(receivedTotalCents),
    receita_pendente_brl: formatBrlFromCents(pendingCents),
    receita_grace_brl: formatBrlFromCents(graceMrrCents),
    receita_risco_brl: formatBrlFromCents(riskMrrCents),
    receita_cancelada_count: canceledCount,
    inadimplencia: subPayload.summary?.past_due ?? 0,
    churn_risco: subPayload.summary?.churn_risk ?? criticalSellers,
    sellers_pagantes: payingSellers,
    trials_ativos: subPayload.summary?.trials_active ?? 0,
    renovacoes_proximas: subPayload.summary?.renewals_upcoming ?? 0,
    ticket_medio_brl: paidCount > 0 ? formatBrlFromCents(Math.round(paidSumCents / paidCount)) : "—",
    assinaturas_ativas: subPayload.summary?.active_subscriptions ?? 0,
  };

  const observability = {
    failed_payments_30d: failed30d,
    critical_sellers: criticalSellers,
    top_plan_by_mrr: topPlan,
    sellers_inadimplentes: summary.inadimplencia,
    payment_approval_rate_30d:
      payments.filter((p) => new Date(String(p.created_at)).getTime() >= days30).length > 0
        ? `${Math.max(0, 100 - Math.round((failed30d / Math.max(1, payments.length)) * 100))}%`
        : "—",
    mrr_trend_label: "Estável",
  };

  return { summary, observability, rows };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {string} traceId
 */
export async function buildDevCenterFinanceDetail(supabase, subscriptionId, traceId) {
  const base = await buildDevCenterSubscriptionDetail(supabase, subscriptionId, traceId);
  if (!base) return null;

  const userId = String(base.subscription?.seller_id ?? "");
  const payments = await loadAllPayments(supabase, traceId);
  const userPayments = payments.filter((p) => String(p.user_id) === userId);
  const subPayments = userPayments.filter((p) => String(p.subscription_id) === subscriptionId);

  let receivedCents = 0;
  let pendingCents = 0;
  let failedCount = 0;

  for (const p of subPayments.length ? subPayments : userPayments) {
    const st = normalizePaymentStatus(p.status);
    const cents = amountToCents(p.amount);
    if (st === "paid") receivedCents += cents;
    if (st === "pending" || st === "overdue") pendingCents += cents;
    if (st === "failed" || st === "overdue") failedCount += 1;
  }

  const mrrCents = Number(base.subscription?.amount_cents ?? 0);

  return {
    ...base,
    finance_summary: {
      mrr_brl: mrrCents > 0 ? formatBrlFromCents(mrrCents) : base.subscription?.amount_brl ?? "—",
      receita_acumulada_brl: formatBrlFromCents(receivedCents),
      receita_pendente_brl: formatBrlFromCents(pendingCents),
      failed_payments_count: failedCount,
      financial_health: base.subscription?.financial_health ?? "saudavel",
      renewal_date: base.billing_summary?.renewal_date ?? null,
    },
    observability: {
      churn_risk: ["risco_churn", "inadimplente"].includes(String(base.subscription?.financial_health)),
      grace_critical: String(base.subscription?.billing_status) === "grace",
      usage_pressure: Boolean(base.usage?.near_limit || base.usage?.exceeded),
    },
    future_actions: {
      ...(base.future_actions ?? {}),
      export_finance: { available: false, label: "Exportar financeiro" },
      refund: { available: false, label: "Estorno admin" },
      forecast: { available: false, label: "Forecast receita" },
      billing_notes: { available: false, label: "Notas financeiras" },
    },
  };
}
