/**
 * S1.HF.6.9A.13A/13B — guarda Preview + ambiente runtime.
 *
 * Opção B — Preview NÃO executa mutações financeiras salvo override explícito.
 * 13B — também bloqueia quando S7_APP_ENV/ASAAS_ENV estão ausentes/inválidos/contraditórios.
 */

import {
  assertBillingFinancialMutationsAllowed,
  BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
  resolveS7RuntimeEnvironment,
} from "./billingRuntimeEnvironmentService.js";

export function isBillingPreviewMutationsBlocked() {
  if (String(process.env.BILLING_PREVIEW_MUTATIONS_ENABLED || "").toLowerCase() === "true") {
    return false;
  }
  return String(process.env.VERCEL_ENV || "").toLowerCase() === "preview";
}

export function isBillingFinancialMutationBlocked() {
  const gate = assertBillingFinancialMutationsAllowed();
  return !gate.ok;
}

export function billingPreviewBlockedPayload(path) {
  const runtime = resolveS7RuntimeEnvironment();
  const previewOnly =
    isBillingPreviewMutationsBlocked() && runtime.ok && runtime.reasons.includes("PREVIEW_MUTATIONS_BLOCKED");
  return {
    ok: false,
    blocked: true,
    code: previewOnly ? "BILLING_PREVIEW_MUTATIONS_BLOCKED" : BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
    path: path || null,
    reasons: runtime.reasons,
    reason: previewOnly
      ? "Preview deployments cannot run financial mutations (S1.HF.6.9A.13A/13B Option B)."
      : "Billing financial mutations blocked: runtime environment unconfirmed.",
  };
}
