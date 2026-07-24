// ======================================================================
// Enforcement backend — APIs premium + capability gate (S1.HF.6.8)
// ======================================================================

import { resolveBillingAccess } from "../services/resolveBillingAccess.js";
import {
  assertBillingEntitlementScope,
  buildEntitlementGateDeniedPayload,
  mapEntitlementGateError,
} from "../services/billingEntitlementGatePolicy.js";

/**
 * @param {import("http").ServerResponse} res
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ module?: string | null }} [options]
 * @returns {Promise<import("../services/resolveBillingAccess.js").ReturnType<typeof resolveBillingAccess> | null>}
 */
export async function assertBillingAccess(res, supabase, userId, options = {}) {
  const billing = await resolveBillingAccess(supabase, userId, options);
  if (billing.premium_access) return billing;

  res.status(403).json({
    ok: false,
    code: billing.access_denied_code || "BILLING_ACCESS_DENIED",
    error: billing.access_denied_message || "Acesso premium indisponível para este usuário.",
    access: billing.access,
    limits: billing.limits,
    plan: billing.plan,
    module: billing.module,
    access_profile: billing.subscription_entitlement?.access_profile ?? null,
    subscription_entitlement: billing.subscription_entitlement ?? null,
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

/**
 * @param {import("http").ServerResponse} res
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} scope
 * @param {{ module?: string | null; now?: Date }} [options]
 * @returns {Promise<boolean>} true quando a requisição deve ser interrompida
 */
export async function gateEntitlementScope(res, supabase, userId, scope, options = {}) {
  try {
    await assertBillingEntitlementScope(supabase, userId, scope, options);
    return false;
  } catch (error) {
    const mapped = mapEntitlementGateError(error);
    res.status(mapped.status).json(buildEntitlementGateDeniedPayload(error, mapped));
    return true;
  }
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {string | null} [module]
 */
export function resolveOperationalGateOptions(req, module = null) {
  try {
    const url = new URL(req.url || "", "http://localhost");
    return {
      module,
      path: url.pathname,
      method: req.method || "GET",
    };
  } catch {
    return { module, path: null, method: req.method || "GET" };
  }
}

/**
 * Premium + capability combinados.
 *
 * @param {import("http").ServerResponse} res
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} scope
 * @param {{ module?: string | null; path?: string | null; method?: string | null }} [options]
 */
export async function gateOperationalScope(res, supabase, userId, scope, options = {}) {
  if (await gatePremiumHandler(res, supabase, userId, options)) return true;
  return gateEntitlementScope(res, supabase, userId, scope, {
    ...options,
    path: options.path ?? null,
    method: options.method ?? "GET",
  });
}
