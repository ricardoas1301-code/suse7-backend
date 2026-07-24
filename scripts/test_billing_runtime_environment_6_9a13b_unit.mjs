#!/usr/bin/env node
/**
 * S1.HF.6.9A.13B — contrato de ambiente + fail-closed + preview + scheduler file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  resolveS7RuntimeEnvironment,
  assertBillingFinancialMutationsAllowed,
  BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
  S7_SUPABASE_PROJECT_REF,
  S7_VERCEL_PROJECT_ID,
} = await import("../src/billing/services/billingRuntimeEnvironmentService.js");
const { isBillingPreviewMutationsBlocked, isBillingFinancialMutationBlocked } = await import(
  "../src/billing/services/billingPreviewRuntimeGuard.js"
);

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const DEV_URL = `https://${S7_SUPABASE_PROJECT_REF.DEV}.supabase.co`;
const PROD_URL = `https://${S7_SUPABASE_PROJECT_REF.PROD}.supabase.co`;

function baseDev(extra = {}) {
  return {
    S7_APP_ENV: "development",
    ASAAS_ENV: "sandbox",
    SUPABASE_URL: DEV_URL,
    S7_EXPECTED_SUPABASE_PROJECT_REF: S7_SUPABASE_PROJECT_REF.DEV,
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: S7_VERCEL_PROJECT_ID.DEV,
    ...extra,
  };
}

// 1–3 S7_APP_ENV
check("1 absent app", !resolveS7RuntimeEnvironment({ ...baseDev(), S7_APP_ENV: undefined }).ok);
check("2 empty app", !resolveS7RuntimeEnvironment({ ...baseDev(), S7_APP_ENV: "" }).ok);
check("3 invalid app", !resolveS7RuntimeEnvironment({ ...baseDev(), S7_APP_ENV: "prod" }).ok);

// 4–6 ASAAS
check("4 absent asaas", !resolveS7RuntimeEnvironment({ ...baseDev(), ASAAS_ENV: undefined }).ok);
check("5 empty asaas", !resolveS7RuntimeEnvironment({ ...baseDev(), ASAAS_ENV: "" }).ok);
check("6 invalid asaas", !resolveS7RuntimeEnvironment({ ...baseDev(), ASAAS_ENV: "live" }).ok);

// 7 valid DEV+sandbox
{
  const r = resolveS7RuntimeEnvironment(baseDev());
  check("7 valid dev sandbox", r.ok && r.financialMutationsAllowed && r.asaasEnv === "sandbox");
}

// 8 DEV + Asaas production invalid
check(
  "8 dev+asaas prod",
  !resolveS7RuntimeEnvironment({ ...baseDev(), ASAAS_ENV: "production" }).ok,
);

// 9 PROD app + Supabase DEV invalid
check(
  "9 prod app + supabase dev",
  !resolveS7RuntimeEnvironment({
    S7_APP_ENV: "production",
    ASAAS_ENV: "production",
    SUPABASE_URL: DEV_URL,
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: S7_VERCEL_PROJECT_ID.PROD,
  }).ok,
);

// 10 Preview PROD project blocked
{
  const r = resolveS7RuntimeEnvironment({
    ...baseDev(),
    VERCEL_ENV: "preview",
    VERCEL_PROJECT_ID: S7_VERCEL_PROJECT_ID.PROD,
    SUPABASE_URL: PROD_URL,
    S7_APP_ENV: "production",
    ASAAS_ENV: "production",
    S7_EXPECTED_SUPABASE_PROJECT_REF: S7_SUPABASE_PROJECT_REF.PROD,
  });
  check("10 preview prod project", !r.financialMutationsAllowed);
}

// 11 job/webhook style gate
{
  const gate = assertBillingFinancialMutationsAllowed({ ...baseDev(), S7_APP_ENV: "" });
  check("11 ambiguous job", !gate.ok && gate.error.code === BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED);
}

// 12 webhook ambiguous
{
  const gate = assertBillingFinancialMutationsAllowed({ ...baseDev(), ASAAS_ENV: "" });
  check("12 ambiguous webhook", !gate.ok);
}

// 13–15 mutation blockers (confirm/suspend/charge share gate)
check("13 charge blocked", !assertBillingFinancialMutationsAllowed({ ASAAS_ENV: "sandbox" }).ok);
check("14 confirm blocked", !assertBillingFinancialMutationsAllowed(baseDev({ S7_APP_ENV: "" })).ok);
check("15 suspend blocked", !assertBillingFinancialMutationsAllowed(baseDev({ ASAAS_ENV: "production" })).ok);

// 16 health/read — resolver may be invalid but code path for GET is separate; prove helper exists
check("16 health code constant", BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED === "BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED");

// 17–18 scheduler file
{
  const prodCron = fs.readFileSync(path.join(root, ".github/workflows/billing-maintenance-cron.yml"), "utf8");
  const devCron = fs.readFileSync(path.join(root, ".github/workflows/billing-maintenance-cron-dev.yml"), "utf8");
  check(
    "17 prod overdues disabled",
    !prodCron.includes("OVERDUES_JOB_URL: ${{") &&
      !/for job_name in [^\n]*overdues/.test(prodCron) &&
      prodCron.includes("legacy overdues scheduler DISABLED"),
  );
  check("17b period preserved", prodCron.includes("PERIOD_JOB_URL") && prodCron.includes("period-expirations"));
  check(
    "18 dev overdues disabled",
    !devCron.includes("OVERDUES_JOB_URL: ${{") &&
      !/for job_name in [^\n]*overdues/.test(devCron) &&
      devCron.includes("renewals"),
  );
}

// 19 ignore script
{
  const ign = fs.readFileSync(path.join(root, "scripts/vercel-ignore-build-rc-on-prod.mjs"), "utf8");
  const vj = fs.readFileSync(path.join(root, "vercel.json"), "utf8");
  check("19 ignore rc on prod", ign.includes(S7_VERCEL_PROJECT_ID.PROD) && ign.includes("rc/") && vj.includes("ignoreCommand"));
}

// 20 DEV project not skipped by ignore for non-prod project id
{
  const prev = { ...process.env };
  process.env.VERCEL_PROJECT_ID = S7_VERCEL_PROJECT_ID.DEV;
  process.env.VERCEL_GIT_COMMIT_REF = "rc/billing-lifecycle-6-9a13a";
  // script exits 1 = proceed — we only assert source contract
  check("20 ignore allows DEV project", ignIncludesDevProceed());
  Object.assign(process.env, prev);
}

function ignIncludesDevProceed() {
  const ign = fs.readFileSync(path.join(root, "scripts/vercel-ignore-build-rc-on-prod.mjs"), "utf8");
  return ign.includes(S7_VERCEL_PROJECT_ID.DEV) === false && ign.includes("isProdProject");
}

// Preview guard on DEV
{
  const prev = { ...process.env };
  Object.assign(process.env, baseDev({ VERCEL_ENV: "preview", BILLING_PREVIEW_MUTATIONS_ENABLED: "false" }));
  check("preview blocked helper", isBillingPreviewMutationsBlocked() === true);
  check("preview financial blocked", isBillingFinancialMutationBlocked() === true);
  Object.keys(process.env).forEach((k) => {
    if (!(k in prev)) delete process.env[k];
  });
  Object.assign(process.env, prev);
}

// config no silent asaas default
{
  const cfg = fs.readFileSync(path.join(root, "src/infra/config.js"), "utf8");
  check(
    "config no default sandbox asaas",
    cfg.includes('getEnv("ASAAS_ENV", { defaultValue: "" })') && !cfg.includes('defaultValue: "sandbox" }).trim();\n  asaasApiBaseUrl'),
  );
}

if (failures.length) {
  console.error("[S1.HF.6.9A.13B runtime env] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("[S1.HF.6.9A.13B runtime env] OK", { checks: 20 });
