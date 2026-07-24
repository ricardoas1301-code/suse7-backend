/**
 * S1.HF.6.9A.13A — guarda Preview no projeto suse7-backend-dev.
 *
 * Decisão: Opção B — Preview NÃO executa jobs/webhooks/mutações financeiras
 * a menos que BILLING_PREVIEW_MUTATIONS_ENABLED=true (override explícito).
 *
 * "Production" no projeto DEV ≠ projeto oficial suse7-backend (PROD).
 */

export function isBillingPreviewMutationsBlocked() {
  if (String(process.env.BILLING_PREVIEW_MUTATIONS_ENABLED || "").toLowerCase() === "true") {
    return false;
  }
  return String(process.env.VERCEL_ENV || "").toLowerCase() === "preview";
}

export function billingPreviewBlockedPayload(path) {
  return {
    ok: false,
    blocked: true,
    code: "BILLING_PREVIEW_MUTATIONS_BLOCKED",
    path: path || null,
    reason:
      "Preview deployments on suse7-backend-dev cannot run financial mutations (S1.HF.6.9A.13A Option B).",
  };
}
