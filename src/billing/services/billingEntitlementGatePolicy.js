// ======================================================================
// Gate backend — rejeição canônica por capability (S1.HF.6.9)
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ENTITLEMENT_CAPABILITY,
  BILLING_ENTITLEMENT_ERROR_CODE,
  BILLING_SYNC_STATE,
} from "../billingConstants.js";
import { resolveRecommendedUpgradeCta } from "./billingAccessProfileService.js";
import { hasEntitlementCapability, resolveBillingEntitlementCapabilities } from "./billingEntitlementCapabilitiesService.js";
import { resolveBillingSubscriptionEntitlementSnapshot } from "./billingSubscriptionEntitlementService.js";
import {
  assertOperationalRouteClassification,
  resolveScopeCapabilityOrFail,
} from "./billingEntitlementRouteRegistry.js";
import { BILLING_GATE_CAPABILITY_BY_SCOPE } from "./billingEntitlementScopeMap.js";
import { logBilling } from "../billingLog.js";

export { BILLING_GATE_CAPABILITY_BY_SCOPE };

/**
 * @param {Record<string, unknown> | null | undefined} entitlement
 * @param {string} capability
 */
export function resolveEntitlementDenialCode(entitlement, capability) {
  const profile = String(entitlement?.access_profile ?? "");
  const syncState = String(entitlement?.sync_state ?? "");

  if (profile === BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY) {
    if (
      capability === BILLING_ENTITLEMENT_CAPABILITY.CHANGE_MARKETPLACE_DATA ||
      capability === BILLING_ENTITLEMENT_CAPABILITY.REQUEST_MANUAL_SYNC ||
      capability === BILLING_ENTITLEMENT_CAPABILITY.RUN_REPORTS ||
      capability === BILLING_ENTITLEMENT_CAPABILITY.EXPORT_DATA ||
      capability === BILLING_ENTITLEMENT_CAPABILITY.EXECUTE_BATCH_ACTIONS ||
      capability === BILLING_ENTITLEMENT_CAPABILITY.RUN_AUTOMATIONS ||
      capability === BILLING_ENTITLEMENT_CAPABILITY.CALL_MARKETPLACE_APIS ||
      capability === BILLING_ENTITLEMENT_CAPABILITY.RECEIVE_AND_PROCESS_WEBHOOKS
    ) {
      return BILLING_ENTITLEMENT_ERROR_CODE.BABY_LIMIT_ARCHIVE_READ_ONLY;
    }
    if (capability === BILLING_ENTITLEMENT_CAPABILITY.VIEW_LIVE_DETAILS) {
      return BILLING_ENTITLEMENT_ERROR_CODE.BABY_LIMIT_ARCHIVE_READ_ONLY;
    }
  }

  if (profile === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY) {
    return BILLING_ENTITLEMENT_ERROR_CODE.PLAN_USAGE_LIMIT_DETAILED_ACCESS_RESTRICTED;
  }

  if (profile === BILLING_ACCESS_PROFILE.FINANCIAL_RECOVERY_ONLY) {
    return BILLING_ENTITLEMENT_ERROR_CODE.FINANCIAL_ACCESS_BLOCKED;
  }

  if (syncState === BILLING_SYNC_STATE.HARD_PAUSED) {
    return BILLING_ENTITLEMENT_ERROR_CODE.SYNC_HARD_PAUSED;
  }

  return BILLING_ENTITLEMENT_ERROR_CODE.PLAN_USAGE_LIMIT_RESTRICTED;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} scope
 * @param {{ now?: Date; subscription?: Record<string, unknown> | null; path?: string | null; method?: string | null }} [options]
 */
export async function assertBillingEntitlementScope(supabase, userId, scope, options = {}) {
  const entitlement = await resolveBillingSubscriptionEntitlementSnapshot(supabase, {
    userId,
    subscription: options.subscription ?? undefined,
    now: options.now,
  });
  const accessProfile = String(entitlement?.access_profile ?? BILLING_ACCESS_PROFILE.FULL_ACCESS);

  if (options.path && options.method) {
    assertOperationalRouteClassification(options.path, options.method, accessProfile);
  }

  const capability = resolveScopeCapabilityOrFail(scope, accessProfile);
  const capabilities = resolveBillingEntitlementCapabilities(entitlement);
  if (hasEntitlementCapability(capabilities, capability)) {
    return { allowed: true, entitlement, capabilities, capability, scope };
  }

  if (process.env.NODE_ENV !== "production") {
    logBilling("billing", "BILLING_ENTITLEMENT_SCOPE_DENIED", {
      user_id: userId,
      scope,
      capability,
      access_profile: accessProfile,
      path: options.path ?? null,
    });
  }

  const errorCode = resolveEntitlementDenialCode(entitlement, capability);
  const error = new Error(errorCode);
  error.code = errorCode;
  error.status = 403;
  error.entitlement = entitlement;
  error.capabilities = capabilities;
  error.capability = capability;
  error.scope = scope;
  throw error;
}

/**
 * @param {unknown} error
 */
export function mapEntitlementGateError(error) {
  const code = String(error?.code ?? error?.message ?? "FORBIDDEN");
  const entitlement = error?.entitlement ?? null;
  const profile = String(entitlement?.access_profile ?? "");

  if (code === BILLING_ENTITLEMENT_ERROR_CODE.BILLING_CAPABILITY_CLASSIFICATION_REQUIRED) {
    return {
      code,
      message: "Esta rota operacional exige classificação de capability antes de ser exposta.",
      status: 403,
    };
  }
  if (code === BILLING_ENTITLEMENT_ERROR_CODE.BABY_LIMIT_ARCHIVE_READ_ONLY) {
    return {
      code,
      message:
        "O limite do plano Baby foi atingido. Você pode consultar dados já sincronizados, mas alterações e sincronizações estão pausadas.",
      status: 403,
    };
  }
  if (code === BILLING_ENTITLEMENT_ERROR_CODE.PLAN_USAGE_LIMIT_DETAILED_ACCESS_RESTRICTED) {
    return {
      code,
      message:
        "Seus indicadores executivos continuam sendo atualizados, mas o acesso aos dados detalhados está temporariamente limitado.",
      status: 403,
    };
  }
  if (code === BILLING_ENTITLEMENT_ERROR_CODE.SYNC_HARD_PAUSED) {
    return {
      code,
      message: "A sincronização está pausada. Consulte os dados armazenados ou regularize sua assinatura.",
      status: 403,
    };
  }
  if (code === BILLING_ENTITLEMENT_ERROR_CODE.FINANCIAL_ACCESS_BLOCKED) {
    return {
      code,
      message: "Regularize sua assinatura para retomar o acesso operacional.",
      status: 403,
    };
  }
  if (code === BILLING_ENTITLEMENT_ERROR_CODE.PLAN_USAGE_LIMIT_RESTRICTED) {
    return {
      code,
      message: "O limite de consumo do plano restringe listas e operações detalhadas neste ciclo.",
      status: 403,
    };
  }
  return {
    code: "FORBIDDEN",
    message: profile ? `Acesso restrito (${profile}).` : "Acesso restrito pelo entitlement atual.",
    status: 403,
  };
}

/**
 * @param {unknown} error
 * @param {{ code: string; message: string; status: number }} mapped
 */
export function buildEntitlementGateDeniedPayload(error, mapped) {
  const entitlement = error?.entitlement ?? null;
  const profile = String(entitlement?.access_profile ?? "");
  const cta = resolveRecommendedUpgradeCta(profile);

  return {
    ok: false,
    code: mapped.code,
    error: mapped.message,
    access_profile: profile || null,
    access_restriction_reason: entitlement?.access_restriction_reason ?? null,
    effective_plan: entitlement?.effective_plan_key ?? entitlement?.effective_plan_label ?? null,
    usage_count: entitlement?.usage_count ?? null,
    usage_limit: entitlement?.usage_limit ?? null,
    sync_state: entitlement?.sync_state ?? null,
    usage_state: entitlement?.usage_state ?? null,
    recommended_cta: cta,
    entitlement_capabilities: error?.capabilities ?? null,
    capability: error?.capability ?? null,
    scope: error?.scope ?? null,
    path: error?.path ?? null,
  };
}
