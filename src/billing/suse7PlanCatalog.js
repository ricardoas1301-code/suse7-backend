// ======================================================================
// Catálogo canônico SUSE7 — planos comerciais (SSOT para seed/migration)
// Métrica de limite: quantidade de vendas/pedidos por mês.
// Preços em centavos (integer); price_monthly derivado apenas para persistência.
// ======================================================================

/** @typedef {"fixed" | "quote"} Suse7PlanPricingMode */

/**
 * @typedef {Object} Suse7CanonicalPlan
 * @property {string} plan_key
 * @property {string} name
 * @property {number} sort_order
 * @property {number | null} price_cents — null somente para quote (Infinity)
 * @property {number | null} sales_limit_monthly — null para Infinity (sem teto fixo)
 * @property {number} sales_range_min — inclusive
 * @property {number | null} sales_range_max — inclusive; null = sem teto superior fixo
 * @property {boolean} billing_required
 * @property {Suse7PlanPricingMode} pricing_mode
 */

/** @type {readonly Suse7CanonicalPlan[]} */
export const SUSE7_CANONICAL_PLANS = [
  {
    plan_key: "baby",
    name: "Baby",
    sort_order: 10,
    price_cents: 0,
    sales_limit_monthly: 60,
    sales_range_min: 0,
    sales_range_max: 60,
    billing_required: false,
    pricing_mode: "fixed",
  },
  {
    plan_key: "start",
    name: "Start",
    sort_order: 20,
    price_cents: 3300,
    sales_limit_monthly: 200,
    sales_range_min: 61,
    sales_range_max: 200,
    billing_required: true,
    pricing_mode: "fixed",
  },
  {
    plan_key: "crescer",
    name: "Crescer",
    sort_order: 30,
    price_cents: 6500,
    sales_limit_monthly: 400,
    sales_range_min: 201,
    sales_range_max: 400,
    billing_required: true,
    pricing_mode: "fixed",
  },
  {
    plan_key: "pro",
    name: "Pro",
    sort_order: 40,
    price_cents: 15600,
    sales_limit_monthly: 1000,
    sales_range_min: 401,
    sales_range_max: 1000,
    billing_required: true,
    pricing_mode: "fixed",
  },
  {
    plan_key: "scale",
    name: "Scale",
    sort_order: 50,
    price_cents: 34900,
    sales_limit_monthly: 2500,
    sales_range_min: 1001,
    sales_range_max: 2500,
    billing_required: true,
    pricing_mode: "fixed",
  },
  {
    plan_key: "elite",
    name: "Elite",
    sort_order: 60,
    price_cents: 63900,
    sales_limit_monthly: 6000,
    sales_range_min: 2501,
    sales_range_max: 6000,
    billing_required: true,
    pricing_mode: "fixed",
  },
  {
    plan_key: "enterprise",
    name: "Enterprise",
    sort_order: 70,
    price_cents: 133300,
    sales_limit_monthly: 20000,
    sales_range_min: 6001,
    sales_range_max: 20000,
    billing_required: true,
    pricing_mode: "fixed",
  },
  {
    plan_key: "infinity",
    name: "Infinity",
    sort_order: 80,
    price_cents: null,
    sales_limit_monthly: null,
    sales_range_min: 20001,
    sales_range_max: null,
    billing_required: true,
    pricing_mode: "quote",
  },
];

/**
 * @param {number | null | undefined} cents
 * @returns {string | null}
 */
export function planCentsToPriceMonthlyString(cents) {
  if (cents == null) return null;
  const value = Number(cents);
  if (!Number.isFinite(value)) return null;
  return (value / 100).toFixed(2);
}

/**
 * @param {import("./services/billingPlanRepository.js").Suse7PlanRow | null | undefined} plan
 */
export function isQuotePlanRow(plan) {
  if (!plan) return false;
  if (String(plan.pricing_mode || "").toLowerCase() === "quote") return true;
  const key = String(plan.plan_key || plan.slug || "").trim().toLowerCase();
  return key === "infinity";
}
