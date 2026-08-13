/**
 * GLOBAL DEV MAINTENANCE MODE — reset/rebuild DEV V2.
 *
 * Durante a virada do DEV, bloqueia TODOS os writers de runtime tenant.
 * Kill switch explícito: DEV_GLOBAL_MAINTENANCE_MODE=1
 * + S7_APP_ENV=development + project_ref ujznkyvgqhxagemdgmor.
 * PROD (bazibzquasbdgjwdcwbz) sempre inativo / abort.
 */

import {
  extractSupabaseProjectRef,
  normalizeS7AppEnv,
  S7_SUPABASE_PROJECT_REF,
} from "../../billing/services/billingRuntimeEnvironmentService.js";

export const DEV_GLOBAL_MAINTENANCE_REASON = "DEV_GLOBAL_MAINTENANCE";
export const DEV_GLOBAL_MAINTENANCE_OUTCOME = "IGNORED_MAINTENANCE";

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function assertDevGlobalMaintenanceNotProd(env = process.env) {
  const ref = extractSupabaseProjectRef(env);
  if (ref === S7_SUPABASE_PROJECT_REF.PROD) {
    throw new Error("DEV_GLOBAL_MAINTENANCE_ABORT_PROD");
  }
  const appEnv = normalizeS7AppEnv(env.S7_APP_ENV);
  if (appEnv === "production") {
    throw new Error("DEV_GLOBAL_MAINTENANCE_ABORT_PRODUCTION_ENV");
  }
}

/**
 * Ativo somente com opt-in explícito DEV_GLOBAL_MAINTENANCE_MODE=1.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function isDevGlobalMaintenanceModeActive(env = process.env) {
  try {
    assertDevGlobalMaintenanceNotProd(env);
  } catch {
    return false;
  }
  const appEnv = normalizeS7AppEnv(env.S7_APP_ENV);
  if (appEnv !== "development") return false;
  const ref = extractSupabaseProjectRef(env);
  if (ref !== S7_SUPABASE_PROJECT_REF.DEV) return false;
  return String(env.DEV_GLOBAL_MAINTENANCE_MODE || "").trim() === "1";
}

/**
 * @param {{
 *   scope?: string | null;
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
 * }} [ctx]
 */
export function evaluateDevGlobalMaintenanceGate(ctx = {}) {
  const env = ctx.env ?? process.env;
  if (!isDevGlobalMaintenanceModeActive(env)) {
    return { blocked: false, active: false, reason: null, outcome: null };
  }
  return {
    blocked: true,
    active: true,
    reason: DEV_GLOBAL_MAINTENANCE_REASON,
    outcome: DEV_GLOBAL_MAINTENANCE_OUTCOME,
    scope: ctx.scope ?? "tenant_runtime",
  };
}

/**
 * @param {{ scope?: string | null; env?: NodeJS.ProcessEnv | Record<string, string | undefined> }} [ctx]
 */
export function buildDevGlobalMaintenanceBlockedApplyResult(ctx = {}) {
  const gate = evaluateDevGlobalMaintenanceGate(ctx);
  if (!gate.blocked) return null;
  return {
    ok: false,
    maintenance_blocked: true,
    entitlement_blocked: false,
    reason: gate.reason,
    domain_code: DEV_GLOBAL_MAINTENANCE_OUTCOME,
    webhook_ok: true,
    processor_outcome: DEV_GLOBAL_MAINTENANCE_OUTCOME,
  };
}

/**
 * @param {Record<string, unknown>} [_event]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function evaluateDevGlobalMaintenanceWebhookEvent(_event = {}, env = process.env) {
  const gate = evaluateDevGlobalMaintenanceGate({ scope: "webhook", env });
  if (!gate.blocked) return { ignore: false, reason: null };
  return {
    ignore: true,
    reason: DEV_GLOBAL_MAINTENANCE_REASON,
    outcome: DEV_GLOBAL_MAINTENANCE_OUTCOME,
  };
}

/**
 * Health/read-only paths não passam por estes hooks.
 * Retorna payload skip para jobs cron durante maintenance.
 *
 * @param {{ jobType?: string | null; env?: NodeJS.ProcessEnv | Record<string, string | undefined> }} [ctx]
 */
export function buildDevGlobalMaintenanceJobSkipResult(ctx = {}) {
  const gate = evaluateDevGlobalMaintenanceGate({ scope: ctx.jobType ?? "job", env: ctx.env });
  if (!gate.blocked) return null;
  return {
    skipped: true,
    maintenance_blocked: true,
    reason: DEV_GLOBAL_MAINTENANCE_REASON,
    outcome: DEV_GLOBAL_MAINTENANCE_OUTCOME,
  };
}
