// ======================================================
// Dev Center — Assinaturas operacional (Fase 2)
// Agrega billing_subscriptions, payments, usage, timeline.
// ======================================================

import { DELINQUENCY_STATUS, SUBSCRIPTION_STATUS } from "../../billing/billingConstants.js";
import { REVENUE_HEALTH_LEVEL } from "../../billing/billingPhase30Constants.js";
import { resolveSubscriptionBillingCycle } from "../../billing/services/billingCycleService.js";
import { listSellerPaymentHistory } from "../../billing/services/billingPaymentsHistoryService.js";
import {
  getActivePlanById,
  getActivePlanByKey,
  listActivePlans,
  resolvePlanDisplayFields,
} from "../../billing/services/billingPlanRepository.js";
import { computeRevenueHealthForUser } from "../../billing/services/billingRevenueHealthService.js";
import { listBillingTimelineForUser } from "../../billing/services/billingTimelineEventService.js";
import {
  pickActiveSubscription,
  pickLatestSubscription,
} from "../../billing/services/billingSubscriptionQueryService.js";
import { resolveMonthlySalesUsage } from "../../billing/services/billingUsageService.js";
import { formatPlanLabel, maskEmailForApi } from "./devCenterSellersService.js";

const SUBSCRIPTION_SELECT =
  "id, user_id, plan_id, plan_key, provider, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at, provider_subscription_id";

/**
 * @param {Record<string, unknown> | null | undefined} sub
 */
function readSubscriptionMeta(sub) {
  return sub?.metadata && typeof sub.metadata === "object"
    ? /** @type {Record<string, unknown>} */ (sub.metadata)
    : {};
}

/**
 * @param {Record<string, unknown> | null | undefined} sub
 */
export function resolveBillingStatusLabel(sub) {
  if (!sub) return "sem_assinatura";
  const status = String(sub.status ?? "").toLowerCase();
  const meta = readSubscriptionMeta(sub);
  const delinquency = String(meta.delinquency_status ?? DELINQUENCY_STATUS.NONE).toLowerCase();
  const renewalStatus = String(meta.renewal_subscription_status ?? "").toUpperCase();

  if (status === SUBSCRIPTION_STATUS.CANCELED) return "canceled";
  if (delinquency === DELINQUENCY_STATUS.SUSPENDED || renewalStatus === "SUSPENDED") return "paused";
  if (status === SUBSCRIPTION_STATUS.PAST_DUE) return "past_due";
  if (delinquency === DELINQUENCY_STATUS.GRACE || renewalStatus === "GRACE_PERIOD") return "grace";
  if (status === SUBSCRIPTION_STATUS.PENDING) return "trialing";
  if (status === SUBSCRIPTION_STATUS.ACTIVE || status === SUBSCRIPTION_STATUS.INTERNAL_FREE) return "active";
  return status || "unknown";
}

/**
 * @param {string | null | undefined} healthLevel
 */
export function mapFinancialHealth(healthLevel, sub) {
  const level = String(healthLevel ?? "").toUpperCase();
  const meta = readSubscriptionMeta(sub);
  const trialEnds = meta.trial_ends_at ?? meta.trial_end_at ?? null;
  if (trialEnds) {
    const ms = new Date(String(trialEnds)).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0 && ms <= 7 * 86400000) return "trial_expirando";
  }
  if (level === REVENUE_HEALTH_LEVEL.CRITICAL) return "inadimplente";
  if (level === REVENUE_HEALTH_LEVEL.RISK) return "risco_churn";
  if (level === REVENUE_HEALTH_LEVEL.WARNING) return "atencao";
  return "saudavel";
}

/**
 * @param {unknown} amount
 */
function formatAmountBrl(amount) {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * @param {unknown} amount
 */
function amountToMonthlyCents(amount) {
  if (amount == null || amount === "") return 0;
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * @param {string | null | undefined} method
 */
function formatPaymentMethod(method) {
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
async function safeSelectAll(supabase, table, select, traceId) {
  const { data, error } = await supabase.from(table).select(select);
  if (error) {
    console.warn("[dev-center-subscriptions] select_failed", { table, message: error.message, traceId });
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * @param {Record<string, unknown>[]} subscriptions
 */
function groupPrimarySubscriptions(subscriptions) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byUser = new Map();
  for (const sub of subscriptions) {
    const uid = sub.user_id != null ? String(sub.user_id) : "";
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(sub);
  }

  /** @type {Record<string, unknown>[]} */
  const primary = [];
  for (const list of byUser.values()) {
    primary.push(pickActiveSubscription(list) ?? pickLatestSubscription(list));
  }
  return primary.filter(Boolean);
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
 * @param {Record<string, unknown>[]} salesRows
 */
function countSalesCurrentMonthByUser(salesRows) {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of salesRows) {
    const uid = row.user_id != null ? String(row.user_id) : "";
    if (!uid) continue;
    const when = row.order_date ?? row.date_created_marketplace ?? row.created_at;
    if (!when) continue;
    if (new Date(String(when)).getTime() < monthStart) continue;
    map.set(uid, (map.get(uid) ?? 0) + 1);
  }
  return map;
}

/**
 * @param {number | null | undefined} used
 * @param {number | null | undefined} limit
 */
function computeUsagePercent(used, limit) {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return null;
  const u = Number.isFinite(used) ? Number(used) : 0;
  return Math.min(999, Math.round((u / limit) * 100));
}

/**
 * @param {Record<string, unknown> | null | undefined} sub
 * @param {Map<string, { sales_limit_monthly?: number | null }>} planByKey
 */
function simplifiedFinancialHealth(sub, planByKey) {
  const status = resolveBillingStatusLabel(sub);
  if (status === "past_due" || status === "paused") return "inadimplente";
  if (status === "grace") return "risco_churn";
  if (status === "trialing") return "trial_expirando";
  if (status === "canceled") return "atencao";
  return "saudavel";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} traceId
 */
export async function buildDevCenterSubscriptionsList(supabase, traceId) {
  const subscriptions = await safeSelectAll(supabase, "billing_subscriptions", SUBSCRIPTION_SELECT, traceId);
  const primarySubs = groupPrimarySubscriptions(subscriptions);
  const userIds = [...new Set(primarySubs.map((s) => String(s.user_id)))];

  const profileSelectVariants = [
    "id, email, nome_loja, nome, photo_url",
    "id, email, nome_loja",
  ];
  let profiles = [];
  if (userIds.length) {
    for (const sel of profileSelectVariants) {
      const { data, error } = await supabase.from("profiles").select(sel).in("id", userIds.slice(0, 400));
      if (!error) {
        profiles = Array.isArray(data) ? data : [];
        break;
      }
    }
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const profileById = new Map(profiles.map((p) => [String(p.id), p]));

  const plans = await listActivePlans(supabase).catch(() => []);
  /** @type {Map<string, { sales_limit_monthly?: number | null; price_monthly?: unknown; name?: string }>} */
  const planByKey = new Map();
  /** @type {Map<string, { sales_limit_monthly?: number | null; price_monthly?: unknown; name?: string }>} */
  const planById = new Map();
  for (const plan of plans) {
    if (plan.plan_key) planByKey.set(String(plan.plan_key).toLowerCase(), plan);
    if (plan.id) planById.set(String(plan.id), plan);
  }

  const payments = await safeSelectAll(
    supabase,
    "billing_payments",
    "id, subscription_id, status, amount, paid_at, created_at, raw_payload",
    traceId,
  );
  const paymentBySub = latestPaymentBySubscription(
    [...payments].sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()),
  );

  const salesRows = await safeSelectAll(
    supabase,
    "sales_orders",
    "user_id, order_date, date_created_marketplace, created_at",
    traceId,
  );
  const salesMonthByUser = countSalesCurrentMonthByUser(salesRows);

  /** @type {Record<string, unknown>[]} */
  const rows = primarySubs.map((sub) => {
    const uid = String(sub.user_id);
    const profile = profileById.get(uid);
    const plan =
      (sub.plan_key && planByKey.get(String(sub.plan_key).toLowerCase())) ||
      (sub.plan_id && planById.get(String(sub.plan_id))) ||
      null;
    const cycle = resolveSubscriptionBillingCycle(sub);
    const billingStatus = resolveBillingStatusLabel(sub);
    const financialHealth = simplifiedFinancialHealth(sub, planByKey);
    const salesUsed = salesMonthByUser.get(uid) ?? 0;
    const usagePercent = computeUsagePercent(salesUsed, plan?.sales_limit_monthly ?? null);
    const payment = paymentBySub.get(String(sub.id));
    const paymentPayload =
      payment?.raw_payload && typeof payment.raw_payload === "object" ? payment.raw_payload : {};
    const paymentMethod = paymentPayload.billingType ?? paymentPayload.paymentMethod ?? null;

    return {
      id: String(sub.id),
      seller_id: uid,
      seller_name: profile?.nome_loja ?? profile?.nome ?? profile?.email ?? "—",
      seller_email: maskEmailForApi(profile?.email) ?? "—",
      seller_photo_url: profile?.photo_url ?? null,
      plan: formatPlanLabel(sub.plan_key ?? sub.plan_id),
      plan_key: sub.plan_key ?? null,
      billing_status: billingStatus,
      financial_health: financialHealth,
      billing_cycle: cycle.window_kind ?? "subscription_cycle",
      current_period_start: cycle.current_period_start ?? sub.current_period_start ?? null,
      current_period_end: cycle.current_period_end ?? sub.current_period_end ?? null,
      renewal_date: cycle.next_billing_at ?? sub.next_due_date ?? sub.current_period_end ?? null,
      started_at: sub.created_at ?? null,
      amount_brl: formatAmountBrl(sub.amount ?? plan?.price_monthly),
      amount_cents: amountToMonthlyCents(sub.amount ?? plan?.price_monthly),
      payment_method: formatPaymentMethod(paymentMethod),
      usage_percent: usagePercent,
      usage_current: salesUsed,
      usage_limit: plan?.sales_limit_monthly ?? null,
      provider: sub.provider ?? null,
      subscription_status: sub.status ?? null,
      updated_at: sub.updated_at ?? null,
    };
  });

  rows.sort((a, b) => new Date(String(b.updated_at)).getTime() - new Date(String(a.updated_at)).getTime());

  const now = Date.now();
  const renewalsUpcoming = rows.filter((r) => {
    const d = r.renewal_date;
    if (!d) return false;
    const ms = new Date(String(d)).getTime() - now;
    return ms >= 0 && ms <= 7 * 86400000;
  }).length;

  let mrrCents = 0;
  let active = 0;
  let grace = 0;
  let pastDue = 0;
  let trials = 0;
  let churnRisk = 0;

  for (const r of rows) {
    const st = String(r.billing_status);
    if (st === "active") {
      active += 1;
      mrrCents += Number(r.amount_cents ?? 0);
    }
    if (st === "grace") grace += 1;
    if (st === "past_due" || st === "paused") pastDue += 1;
    if (st === "trialing") trials += 1;
    if (r.financial_health === "risco_churn" || r.financial_health === "inadimplente") churnRisk += 1;
  }

  return {
    summary: {
      active_subscriptions: active,
      grace_period: grace,
      past_due: pastDue,
      trials_active: trials,
      mrr_brl: (mrrCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
      arr_brl: ((mrrCents * 12) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
      churn_risk: churnRisk,
      renewals_upcoming: renewalsUpcoming,
    },
    subscriptions: rows,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {string} traceId
 */
export async function buildDevCenterSubscriptionDetail(supabase, subscriptionId, traceId) {
  const { data: sub, error } = await supabase
    .from("billing_subscriptions")
    .select(SUBSCRIPTION_SELECT)
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error || !sub) return null;

  const userId = String(sub.user_id);
  const profileSelectVariants = [
    "id, email, nome_loja, nome, photo_url, telefone, whatsapp",
    "id, email, nome_loja, nome",
  ];
  let profile = null;
  for (const sel of profileSelectVariants) {
    const { data, error: pErr } = await supabase.from("profiles").select(sel).eq("id", userId).maybeSingle();
    if (!pErr && data) {
      profile = data;
      break;
    }
  }

  const plan =
    (sub.plan_key ? await getActivePlanByKey(supabase, String(sub.plan_key)).catch(() => null) : null) ??
    (sub.plan_id ? await getActivePlanById(supabase, String(sub.plan_id)).catch(() => null) : null);
  const planFields = resolvePlanDisplayFields(plan);
  const cycle = resolveSubscriptionBillingCycle(sub);
  const meta = readSubscriptionMeta(sub);
  const billingStatus = resolveBillingStatusLabel(sub);

  const [revenueHealth, payments, timeline, renewalCycles] = await Promise.all([
    computeRevenueHealthForUser(supabase, userId, { subscription: sub, persist: false }).catch(() => null),
    listSellerPaymentHistory(supabase, userId).catch(() => []),
    listBillingTimelineForUser(supabase, userId, { subscriptionId, limit: 30 }).catch(() => []),
    supabase
      .from("billing_renewal_cycles")
      .select("id, renewal_status, renewal_due_date, renewal_strategy, created_at, updated_at")
      .eq("subscription_id", subscriptionId)
      .order("created_at", { ascending: false })
      .limit(8)
      .then((r) => r.data ?? [])
      .catch(() => []),
  ]);

  let usage = null;
  try {
    usage = await resolveMonthlySalesUsage(supabase, userId, sub.plan_id != null ? String(sub.plan_id) : null, cycle);
  } catch (e) {
    console.warn("[dev-center-subscriptions] usage_failed", { userId, message: e?.message, traceId });
  }

  const financialHealth = mapFinancialHealth(revenueHealth?.health_level, sub);
  const subPayments = payments.filter((p) => p.subscription_id === subscriptionId);
  const lastPayment = subPayments[0] ?? payments[0] ?? null;
  const failedRecent = payments.filter((p) => ["failed", "overdue"].includes(String(p.status))).slice(0, 5);

  /** @type {{ id: string; kind: string; label: string; at: string; severity?: string }[]} */
  const timelineEvents = (timeline ?? []).map((evt) => ({
    id: String(evt.id),
    kind: String(evt.event_type ?? "event"),
    label: String(evt.title ?? evt.event_type ?? "Evento billing"),
    summary: evt.summary ?? null,
    at: String(evt.occurred_at ?? evt.created_at ?? new Date().toISOString()),
    severity: evt.severity ?? "info",
  }));

  if (timelineEvents.length === 0) {
    timelineEvents.push({
      id: "evt-created",
      kind: "SUBSCRIPTION_CREATED",
      label: "Assinatura criada",
      at: String(sub.created_at ?? new Date().toISOString()),
      severity: "info",
    });
    if (lastPayment?.paid_at) {
      timelineEvents.push({
        id: `evt-pay-${lastPayment.id}`,
        kind: "PAYMENT_CONFIRMED",
        label: "Último pagamento confirmado",
        at: String(lastPayment.paid_at),
        severity: "info",
      });
    }
  }

  /** @type {string[]} */
  const alerts = [];
  if (billingStatus === "grace") alerts.push("Seller em grace period — risco de suspensão.");
  if (billingStatus === "past_due") alerts.push("Assinatura inadimplente.");
  if (usage?.exceeded) alerts.push("Limite mensal de vendas excedido.");
  if (usage?.near_limit) alerts.push("Consumo próximo do limite do plano.");
  if (financialHealth === "trial_expirando") alerts.push("Trial expirando em breve.");

  return {
    subscription: {
      id: subscriptionId,
      seller_id: userId,
      seller_name: profile?.nome_loja ?? profile?.nome ?? profile?.email ?? "—",
      seller_email: maskEmailForApi(profile?.email) ?? "—",
      seller_photo_url: profile?.photo_url ?? null,
      plan_key: sub.plan_key ?? null,
      plan_label: formatPlanLabel(sub.plan_key ?? planFields.plan_name),
      plan_display: planFields.display_name ?? planFields.plan_name,
      billing_status: billingStatus,
      subscription_status: sub.status ?? null,
      financial_health: financialHealth,
      amount_brl: formatAmountBrl(sub.amount ?? plan?.price_monthly),
      amount_cents: amountToMonthlyCents(sub.amount ?? plan?.price_monthly),
      provider: sub.provider ?? null,
      created_at: sub.created_at ?? null,
      updated_at: sub.updated_at ?? null,
    },
    billing_summary: {
      billing_cycle: cycle.window_kind ?? "subscription_cycle",
      current_period_start: cycle.current_period_start ?? null,
      current_period_end: cycle.current_period_end ?? null,
      renewal_date: cycle.next_billing_at ?? sub.next_due_date ?? null,
      payment_method: lastPayment ? formatPaymentMethod(lastPayment.payment_method_type) : "—",
      last_payment_at: lastPayment?.paid_at ?? lastPayment?.created_at ?? null,
      last_payment_amount_brl:
        lastPayment?.amount_cents != null
          ? (lastPayment.amount_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
          : null,
      delinquency_status: meta.delinquency_status ?? null,
      renewal_subscription_status: meta.renewal_subscription_status ?? null,
      grace_period_ends_at: meta.grace_period_ends_at ?? null,
    },
    usage: usage
      ? {
          current: usage.current_month_sales ?? 0,
          limit: usage.monthly_sales_limit ?? plan?.sales_limit_monthly ?? null,
          percent: usage.usage_percent ?? computeUsagePercent(usage.current_month_sales, usage.monthly_sales_limit),
          near_limit: Boolean(usage.near_limit),
          exceeded: Boolean(usage.exceeded),
          period_start: usage.period_start ?? cycle.period_start ?? null,
          period_end: usage.period_end ?? cycle.period_end ?? null,
        }
      : {
          current: null,
          limit: plan?.sales_limit_monthly ?? null,
          percent: null,
          near_limit: false,
          exceeded: false,
          period_start: cycle.period_start ?? null,
          period_end: cycle.period_end ?? null,
        },
    revenue_health: revenueHealth,
    payments: subPayments.slice(0, 12),
    failed_payments_recent: failedRecent,
    renewal_cycles: renewalCycles,
    timeline: timelineEvents,
    alerts,
    future_actions: {
      reactivate: { available: false, label: "Reativar assinatura" },
      cancel: { available: false, label: "Cancelar assinatura" },
      change_plan: { available: false, label: "Alterar plano" },
      adjust_limits: { available: false, label: "Ajustar limites" },
      billing_notes: { available: false, label: "Notas billing" },
      refund: { available: false, label: "Estorno admin" },
    },
  };
}
