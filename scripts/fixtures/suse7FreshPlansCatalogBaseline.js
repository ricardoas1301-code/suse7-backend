/**
 * Fixture — baseline comercial Fresh DEV V2 (INITIAL DATABASE BASELINE only).
 * NÃO é SSOT runtime. Usado por testes/harness de replay.
 */
export const SUSE7_FRESH_PLANS_CATALOG_BASELINE = [
  { plan_key: "baby", name: "Baby", canonical_id: "a1000001-0001-4001-8001-000000000001", sort_order: 10, price_cents: 5900, sales_limit_monthly: 50, sales_range_min: 0, sales_range_max: 50, billing_required: true, pricing_mode: "fixed" },
  { plan_key: "start", name: "Start", canonical_id: "a1000001-0001-4001-8001-000000000002", sort_order: 20, price_cents: 9900, sales_limit_monthly: 200, sales_range_min: 51, sales_range_max: 200, billing_required: true, pricing_mode: "fixed" },
  { plan_key: "crescer", name: "Crescer", canonical_id: "a1000001-0001-4001-8001-000000000003", sort_order: 30, price_cents: 15500, sales_limit_monthly: 500, sales_range_min: 201, sales_range_max: 500, billing_required: true, pricing_mode: "fixed" },
  { plan_key: "pro", name: "Pro", canonical_id: "a1000001-0001-4001-8001-000000000004", sort_order: 40, price_cents: 24900, sales_limit_monthly: 1000, sales_range_min: 501, sales_range_max: 1000, billing_required: true, pricing_mode: "fixed" },
  { plan_key: "scale", name: "Scale", canonical_id: "a1000001-0001-4001-8001-000000000005", sort_order: 50, price_cents: 39900, sales_limit_monthly: 3000, sales_range_min: 1001, sales_range_max: 3000, billing_required: true, pricing_mode: "fixed" },
  { plan_key: "elite", name: "Elite", canonical_id: "a1000001-0001-4001-8001-000000000006", sort_order: 60, price_cents: 64900, sales_limit_monthly: 10000, sales_range_min: 3001, sales_range_max: 10000, billing_required: true, pricing_mode: "fixed" },
  { plan_key: "enterprise", name: "Enterprise", canonical_id: "a1000001-0001-4001-8001-000000000007", sort_order: 70, price_cents: 109900, sales_limit_monthly: 20000, sales_range_min: 10001, sales_range_max: 20000, billing_required: true, pricing_mode: "fixed" },
  { plan_key: "infinity", name: "Infinity", canonical_id: "a1000001-0001-4001-8001-000000000008", sort_order: 80, price_cents: null, sales_limit_monthly: null, sales_range_min: 20001, sales_range_max: null, billing_required: true, pricing_mode: "quote" },
];

export function planCentsToPriceMonthlyString(cents) {
  if (cents == null) return null;
  const value = Number(cents);
  if (!Number.isFinite(value)) return null;
  return (value / 100).toFixed(2);
}
