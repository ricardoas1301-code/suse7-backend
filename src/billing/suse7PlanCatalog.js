// ======================================================================
// Helpers de plano comercial — leitura de row DB (sem catálogo hardcoded)
// ======================================================================

/**
 * @param {import("./services/billingPlanRepository.js").Suse7PlanRow | null | undefined} plan
 */
export function isQuotePlanRow(plan) {
  if (!plan) return false;
  if (String(plan.pricing_mode || "").toLowerCase() === "quote") return true;
  const key = String(plan.plan_key || plan.slug || "").trim().toLowerCase();
  return key === "infinity";
}
