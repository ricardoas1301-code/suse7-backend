// ======================================================================
// Preço efetivo de renovação — SSOT modular (histórico vs vigente vs ciclo)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";
import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";
import { getActivePlanById } from "./billingPlanRepository.js";

/** @typedef {"cycle_materialized" | "commercial_terms" | "promotional" | "plan_catalog" | "subscription_legacy"} BillingRenewalPriceSource */

export const BILLING_RENEWAL_PRICE_SOURCE = /** @type {const} */ ({
  CYCLE_MATERIALIZED: "cycle_materialized",
  COMMERCIAL_TERMS: "commercial_terms",
  PROMOTIONAL: "promotional",
  PLAN_CATALOG: "plan_catalog",
  SUBSCRIPTION_LEGACY: "subscription_legacy",
});

/**
 * @param {unknown} metadata
 */
function readObject(metadata) {
  return metadata && typeof metadata === "object" ? /** @type {Record<string, unknown>} */ (metadata) : null;
}

/**
 * @param {unknown} value
 */
function readMoneyString(value) {
  if (value == null || value === "") return null;
  try {
    const amount = decimalToScale2String(toDecimal(value));
    return toDecimal(amount).gt(0) ? amount : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
function readCommercialRenewalAmount(metadata) {
  const meta = readObject(metadata);
  if (!meta) return null;
  const terms = readObject(meta.commercial_terms) ?? readObject(meta.billing_commercial_terms);
  if (!terms) return null;
  return readMoneyString(terms.renewal_amount ?? terms.fixed_amount ?? terms.amount);
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 * @param {string | null} civilDate YYYY-MM-DD
 */
function readPromotionalRenewalAmount(metadata, civilDate) {
  const meta = readObject(metadata);
  if (!meta || !civilDate) return null;
  const promo = readObject(meta.promotional_renewal_price) ?? readObject(meta.billing_promotional_price);
  if (!promo) return null;
  const amount = readMoneyString(promo.amount ?? promo.price);
  if (!amount) return null;
  const effectiveFrom = typeof promo.effective_from === "string" ? promo.effective_from.slice(0, 10) : null;
  const effectiveUntil = typeof promo.effective_until === "string" ? promo.effective_until.slice(0, 10) : null;
  if (effectiveFrom && civilDate < effectiveFrom) return null;
  if (effectiveUntil && civilDate > effectiveUntil) return null;
  return amount;
}

/**
 * @param {Record<string, unknown> | null | undefined} cycle
 */
function readMaterializedCycleAmount(cycle) {
  if (!cycle) return null;
  const direct = readMoneyString(cycle.amount_due);
  if (direct) return direct;
  const meta = readObject(cycle.metadata);
  return readMoneyString(meta?.amount_due);
}

/**
 * Precedência:
 * 1. amount_due materializado no ciclo
 * 2. condição comercial explícita
 * 3. preço promocional vigente
 * 4. catálogo do plano
 * 5. billing_subscriptions.amount (legado)
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   subscription: Record<string, unknown>;
 *   openRenewalCycle?: Record<string, unknown> | null;
 *   plan?: import("./billingPlanRepository.js").Suse7PlanRow | null;
 *   now?: Date;
 * }} input
 */
export async function resolveEffectiveRenewalPrice(supabase, input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const subscription = input.subscription;
  const openRenewalCycle = input.openRenewalCycle ?? null;

  const materialized = readMaterializedCycleAmount(openRenewalCycle);
  if (materialized) {
    return {
      amount: materialized,
      source: BILLING_RENEWAL_PRICE_SOURCE.CYCLE_MATERIALIZED,
      catalog_plan_id: subscription?.plan_id != null ? String(subscription.plan_id) : null,
      effective_on: civilNow,
    };
  }

  const commercial = readCommercialRenewalAmount(subscription?.metadata);
  if (commercial) {
    return {
      amount: commercial,
      source: BILLING_RENEWAL_PRICE_SOURCE.COMMERCIAL_TERMS,
      catalog_plan_id: subscription?.plan_id != null ? String(subscription.plan_id) : null,
      effective_on: civilNow,
    };
  }

  const promotional = readPromotionalRenewalAmount(subscription?.metadata, civilNow);
  if (promotional) {
    return {
      amount: promotional,
      source: BILLING_RENEWAL_PRICE_SOURCE.PROMOTIONAL,
      catalog_plan_id: subscription?.plan_id != null ? String(subscription.plan_id) : null,
      effective_on: civilNow,
    };
  }

  let plan = input.plan ?? null;
  if (!plan && subscription?.plan_id) {
    plan = await getActivePlanById(supabase, String(subscription.plan_id));
  }
  if (plan?.price_monthly != null) {
    return {
      amount: decimalToScale2String(toDecimal(plan.price_monthly)),
      source: BILLING_RENEWAL_PRICE_SOURCE.PLAN_CATALOG,
      catalog_plan_id: String(plan.id),
      catalog_plan_key: String(plan.plan_key),
      effective_on: civilNow,
    };
  }

  const legacy = readMoneyString(subscription?.amount);
  if (legacy) {
    return {
      amount: legacy,
      source: BILLING_RENEWAL_PRICE_SOURCE.SUBSCRIPTION_LEGACY,
      catalog_plan_id: subscription?.plan_id != null ? String(subscription.plan_id) : null,
      effective_on: civilNow,
    };
  }

  return {
    amount: null,
    source: null,
    catalog_plan_id: subscription?.plan_id != null ? String(subscription.plan_id) : null,
    effective_on: civilNow,
  };
}

/**
 * Congela amount_due no ciclo (metadata até coluna dedicada existir).
 *
 * @param {Record<string, unknown>} cycle
 * @param {string} amount
 * @param {BillingRenewalPriceSource} source
 */
export function buildRenewalCycleAmountDuePatch(cycle, amount, source) {
  const meta =
    cycle?.metadata && typeof cycle.metadata === "object"
      ? { .../** @type {Record<string, unknown>} */ (cycle.metadata) }
      : {};
  meta.amount_due = amount;
  meta.amount_due_source = source;
  meta.amount_due_frozen_at = new Date().toISOString();
  return {
    amount_due: amount,
    metadata: meta,
  };
}

/**
 * @param {Awaited<ReturnType<typeof resolveEffectiveRenewalPrice>>} resolved
 * @param {Record<string, unknown>} context
 */
export function logEffectiveRenewalPriceResolved(resolved, context) {
  logBilling("billing", "BILLING_EFFECTIVE_RENEWAL_PRICE_RESOLVED", {
    ...context,
    amount: resolved.amount,
    source: resolved.source,
    catalog_plan_id: resolved.catalog_plan_id ?? null,
  });
}
