// ======================================================================
// Enforcement backend — APIs premium
// ======================================================================

import { resolveBillingAccess } from "../services/resolveBillingAccess.js";
import { resolveBillingAccessGateCached } from "../services/billingAccessGateCache.js";

/**
 * @param {import("http").ServerResponse} res
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ module?: string | null; usageScope?: "full" | "gate" }} [options]
 * @returns {Promise<import("../services/resolveBillingAccess.js").ReturnType<typeof resolveBillingAccess> | null>}
 */
export async function assertBillingAccess(res, supabase, userId, options = {}) {
  const billing =
    options.usageScope === "gate"
      ? await resolveBillingAccessGateCached(supabase, userId, options)
      : await resolveBillingAccess(supabase, userId, options);
  if (billing.premium_access) return billing;

  res.status(403).json({
    ok: false,
    code: billing.access_denied_code || "BILLING_ACCESS_DENIED",
    error: billing.access_denied_message || "Acesso premium indisponível para este usuário.",
    access: billing.access,
    limits: billing.limits,
    plan: billing.plan,
    module: billing.module,
  });
  return null;
}

/**
 * @param {import("http").ServerResponse} res
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ module?: string | null }} [options]
 * @returns {Promise<boolean>} true quando a requisição deve ser interrompida
 */
export async function gatePremiumHandler(res, supabase, userId, options = {}) {
  const billing = await assertBillingAccess(res, supabase, userId, options);
  return billing == null;
}
