/**
 * S1.HF.6.9A.13B — resolver canônico de ambiente runtime (fail-closed).
 *
 * Enums reais do código (config.js / uso existente):
 * - S7_APP_ENV: development | staging | production
 * - ASAAS_ENV: sandbox | production | prod (normalizado → production)
 *
 * Identidade Supabase: S7_EXPECTED_SUPABASE_PROJECT_REF (declarado) === ref de SUPABASE_URL (real).
 * Sem fallback silencioso para sandbox/production/development.
 */

import {
  extractSupabaseProjectRef,
  readExpectedSupabaseProjectRef,
  resolveSupabaseRuntimeIdentity,
  S7_KNOWN_SUPABASE_PROJECT_REF,
  S7_LEGACY_SUPABASE_PROJECT_REF,
} from "../../infra/supabaseRuntimeIdentityService.js";

export const BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED = "BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED";

/** Refs conhecidos — somente para guards explícitos (PROD, legado Vercel). Não definem “o que é DEV”. */
export const S7_SUPABASE_PROJECT_REF = Object.freeze({
  DEV: S7_LEGACY_SUPABASE_PROJECT_REF.DEV_V1,
  PROD: S7_KNOWN_SUPABASE_PROJECT_REF.PROD,
});

export { extractSupabaseProjectRef, readExpectedSupabaseProjectRef, resolveSupabaseRuntimeIdentity };

export const S7_VERCEL_PROJECT_ID = Object.freeze({
  DEV: "prj_TvAjlZFVkLOrgxW7bgGD5VIX7LK3",
  PROD: "prj_82lxqfRgGm33UeWMWvrQt9qe5EwZ",
});

const S7_APP_ENV_ALLOWED = new Set(["development", "staging", "production"]);
const ASAAS_ENV_ALLOWED = new Set(["sandbox", "production"]);

/**
 * @param {unknown} raw
 */
export function normalizeAsaasEnv(raw) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!v) return null;
  if (v === "prod") return "production";
  if (ASAAS_ENV_ALLOWED.has(v)) return v;
  return null;
}

/**
 * @param {unknown} raw
 */
export function normalizeS7AppEnv(raw) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!v) return null;
  if (S7_APP_ENV_ALLOWED.has(v)) return v;
  return null;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function resolveS7RuntimeEnvironment(env = process.env) {
  /** @type {string[]} */
  const reasons = [];
  const vercelEnv = String(env.VERCEL_ENV || "")
    .trim()
    .toLowerCase() || null;
  const vercelProjectId = String(env.VERCEL_PROJECT_ID || "")
    .trim() || null;

  const rawApp = String(env.S7_APP_ENV ?? "").trim();
  const rawAsaas = String(env.ASAAS_ENV ?? "").trim();
  if (!rawApp) reasons.push("S7_APP_ENV_ABSENT");
  if (rawApp !== "" && !normalizeS7AppEnv(rawApp)) reasons.push("S7_APP_ENV_INVALID");
  if (!rawAsaas) reasons.push("ASAAS_ENV_ABSENT");
  if (rawAsaas !== "" && !normalizeAsaasEnv(rawAsaas)) reasons.push("ASAAS_ENV_INVALID");

  const s7AppEnv = normalizeS7AppEnv(rawApp);
  const asaasEnv = normalizeAsaasEnv(rawAsaas);
  const supabaseProjectRef = extractSupabaseProjectRef(env);
  const expectedRef = readExpectedSupabaseProjectRef(env);
  const identity = resolveSupabaseRuntimeIdentity(env);

  for (const reason of identity.reasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  if (s7AppEnv === "development" || s7AppEnv === "staging") {
    if (asaasEnv && asaasEnv !== "sandbox") reasons.push("DEV_APP_REQUIRES_ASAAS_SANDBOX");
    if (!expectedRef) reasons.push("DEV_APP_REQUIRES_EXPECTED_SUPABASE_PROJECT_REF");
    if (!supabaseProjectRef) reasons.push("DEV_APP_REQUIRES_SUPABASE_URL");
    if (expectedRef && supabaseProjectRef && expectedRef !== supabaseProjectRef) {
      reasons.push("DEV_APP_REQUIRES_SUPABASE_DEV");
    }
    if (supabaseProjectRef === S7_SUPABASE_PROJECT_REF.PROD) {
      reasons.push("DEV_APP_POINTS_TO_SUPABASE_PROD");
    }
  }

  if (s7AppEnv === "production") {
    if (asaasEnv && asaasEnv !== "production") reasons.push("PROD_APP_REQUIRES_ASAAS_PRODUCTION");
    if (!expectedRef) reasons.push("PROD_APP_REQUIRES_EXPECTED_SUPABASE_PROJECT_REF");
    if (!supabaseProjectRef) reasons.push("PROD_APP_REQUIRES_SUPABASE_URL");
    if (supabaseProjectRef && supabaseProjectRef !== S7_SUPABASE_PROJECT_REF.PROD) {
      reasons.push("PROD_APP_REQUIRES_SUPABASE_PROD");
    }
    if (supabaseProjectRef === S7_SUPABASE_PROJECT_REF.DEV) {
      reasons.push("PROD_APP_POINTS_TO_SUPABASE_DEV");
    }
  }

  if (asaasEnv === "production" && s7AppEnv && s7AppEnv !== "production") {
    reasons.push("ASAAS_PRODUCTION_WITH_NON_PROD_APP");
  }

  if (
    vercelProjectId === S7_VERCEL_PROJECT_ID.PROD &&
    supabaseProjectRef &&
    supabaseProjectRef !== S7_SUPABASE_PROJECT_REF.PROD
  ) {
    reasons.push("VERCEL_PROD_PROJECT_WITH_SUPABASE_DEV");
  }

  const previewMutationsEnabled =
    String(env.BILLING_PREVIEW_MUTATIONS_ENABLED || "").toLowerCase() === "true";
  const isPreview = vercelEnv === "preview";

  if (isPreview && vercelProjectId === S7_VERCEL_PROJECT_ID.PROD) {
    reasons.push("PREVIEW_ON_VERCEL_PROD_PROJECT");
  }

  const contractOk = reasons.length === 0 && Boolean(s7AppEnv) && Boolean(asaasEnv);

  let financialMutationsAllowed = contractOk;
  if (isPreview && !previewMutationsEnabled) {
    financialMutationsAllowed = false;
    if (contractOk) reasons.push("PREVIEW_MUTATIONS_BLOCKED");
  }
  if (isPreview && vercelProjectId === S7_VERCEL_PROJECT_ID.PROD) {
    financialMutationsAllowed = false;
  }

  return {
    ok: contractOk,
    code: contractOk && financialMutationsAllowed ? null : BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
    s7AppEnv,
    asaasEnv,
    vercelEnv,
    vercelProjectId,
    supabaseProjectRef,
    expectedSupabaseProjectRef: expectedRef,
    supabaseRuntimeIdentity: identity,
    financialMutationsAllowed,
    isPreview,
    reasons,
  };
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function assertBillingFinancialMutationsAllowed(env = process.env) {
  const runtime = resolveS7RuntimeEnvironment(env);
  if (runtime.financialMutationsAllowed) {
    return { ok: true, runtime };
  }
  return {
    ok: false,
    runtime,
    error: {
      ok: false,
      blocked: true,
      code: BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
      reasons: runtime.reasons,
      s7_app_env: runtime.s7AppEnv,
      asaas_env: runtime.asaasEnv,
      vercel_env: runtime.vercelEnv,
      supabase_project_ref: runtime.supabaseProjectRef,
    },
  };
}
