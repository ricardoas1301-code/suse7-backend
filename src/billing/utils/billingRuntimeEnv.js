// ======================================================================
// Runtime — produção vs diagnósticos DEV (Fase 3.0.4)
// ======================================================================

/**
 * Ambiente Vercel/node considerado produção operacional.
 */
export function isBillingProductionRuntime() {
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  if (vercelEnv === "production") return true;
  const asaasEnv = String(process.env.ASAAS_ENV || "").toLowerCase();
  if (asaasEnv === "production") return true;
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

/**
 * Logs de teste/diagnóstico (ex.: BILLING TEST transitions) — nunca em produção.
 */
export function isBillingDevDiagnosticsEnabled() {
  if (!isBillingProductionRuntime()) return true;
  return process.env.BILLING_ALLOW_DEV_DIAGNOSTICS === "1";
}
