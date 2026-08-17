#!/usr/bin/env node
/**
 * DEV.V2.RUNTIME-IDENTITY-GATES-V2.15 — matriz expected/actual Supabase runtime.
 */

import assert from "node:assert/strict";
import {
  resolveSupabaseRuntimeIdentity,
  isDevSupabaseRuntimeIdentityCoherent,
  S7_KNOWN_SUPABASE_PROJECT_REF,
  S7_LEGACY_SUPABASE_PROJECT_REF,
} from "../src/infra/supabaseRuntimeIdentityService.js";
import {
  resolveS7RuntimeEnvironment,
  S7_SUPABASE_PROJECT_REF,
  S7_VERCEL_PROJECT_ID,
} from "../src/billing/services/billingRuntimeEnvironmentService.js";
import {
  isDevGlobalMaintenanceModeActive,
  resolveDevGlobalMaintenanceState,
} from "../src/domain/dev/devGlobalMaintenanceMode.js";

const V2_REF = "alkelcaoexxbamqddaqv";
const V1_REF = S7_LEGACY_SUPABASE_PROJECT_REF.DEV_V1;
const PROD_REF = S7_KNOWN_SUPABASE_PROJECT_REF.PROD;

function devBase(ref, extra = {}) {
  return {
    S7_APP_ENV: "development",
    ASAAS_ENV: "sandbox",
    SUPABASE_URL: `https://${ref}.supabase.co`,
    S7_EXPECTED_SUPABASE_PROJECT_REF: ref,
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: S7_VERCEL_PROJECT_ID.DEV,
    DEV_GLOBAL_MAINTENANCE_MODE: "1",
    ...extra,
  };
}

const matrix = [];

function record(caseId, pass, detail) {
  matrix.push({ caseId, pass, ...detail });
  assert.ok(pass, caseId);
}

// Identity service
{
  const id = resolveSupabaseRuntimeIdentity(devBase(V2_REF));
  record("ID-A V2 match", id.ok && id.matched, { identity: id });
}

{
  const id = resolveSupabaseRuntimeIdentity(devBase(V1_REF));
  record("ID-B V1 match", id.ok && id.matched, { identity: id });
}

{
  const id = resolveSupabaseRuntimeIdentity({
    ...devBase(V2_REF),
    SUPABASE_URL: `https://${V1_REF}.supabase.co`,
  });
  record("ID-C V2 expected V1 actual fail", !id.ok, { identity: id });
}

{
  const id = resolveSupabaseRuntimeIdentity({
    S7_APP_ENV: "development",
    SUPABASE_URL: `https://${V2_REF}.supabase.co`,
  });
  record("ID-E expected absent fail", !id.ok, { identity: id });
}

{
  const id = resolveSupabaseRuntimeIdentity({
    ...devBase(V2_REF),
    SUPABASE_URL: "https://invalid",
  });
  record("ID-F malformed url fail", !id.ok, { identity: id });
}

{
  const id = resolveSupabaseRuntimeIdentity({
    S7_APP_ENV: "production",
    ASAAS_ENV: "production",
    SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    S7_EXPECTED_SUPABASE_PROJECT_REF: PROD_REF,
  });
  record("ID-G prod identity", id.ok && id.isProdTarget, { identity: id });
}

// Billing runtime
{
  const r = resolveS7RuntimeEnvironment(devBase(V2_REF));
  record(
    "BILL-A DEV V2 pass",
    r.ok && r.financialMutationsAllowed && !r.reasons.includes("DEV_APP_REQUIRES_SUPABASE_DEV"),
    { reasons: r.reasons },
  );
}

{
  const r = resolveS7RuntimeEnvironment(devBase(V1_REF));
  record("BILL-B DEV V1 pass", r.ok && r.financialMutationsAllowed, { reasons: r.reasons });
}

{
  const r = resolveS7RuntimeEnvironment({
    ...devBase(V2_REF),
    SUPABASE_URL: `https://${V1_REF}.supabase.co`,
  });
  record(
    "BILL-C mismatch fail",
    !r.ok && r.reasons.includes("DEV_APP_REQUIRES_SUPABASE_DEV"),
    { reasons: r.reasons },
  );
}

{
  const r = resolveS7RuntimeEnvironment({
    ...devBase(V2_REF),
    SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    S7_EXPECTED_SUPABASE_PROJECT_REF: PROD_REF,
  });
  record(
    "BILL-E DEV actual prod fail",
    !r.ok && r.reasons.includes("DEV_APP_POINTS_TO_SUPABASE_PROD"),
    { reasons: r.reasons },
  );
}

{
  const r = resolveS7RuntimeEnvironment({
    ...devBase(V2_REF),
    S7_EXPECTED_SUPABASE_PROJECT_REF: undefined,
  });
  record(
    "BILL-F expected missing fail",
    !r.ok && r.reasons.includes("DEV_APP_REQUIRES_EXPECTED_SUPABASE_PROJECT_REF"),
    { reasons: r.reasons },
  );
}

{
  const r = resolveS7RuntimeEnvironment({
    S7_APP_ENV: "production",
    ASAAS_ENV: "production",
    SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    S7_EXPECTED_SUPABASE_PROJECT_REF: PROD_REF,
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: S7_VERCEL_PROJECT_ID.PROD,
  });
  record("BILL-H prod contract preserved", r.ok && r.financialMutationsAllowed, { reasons: r.reasons });
}

// Maintenance
record(
  "MAINT-A V2 active",
  isDevGlobalMaintenanceModeActive(devBase(V2_REF)),
  {},
);
record(
  "MAINT-B V1 active",
  isDevGlobalMaintenanceModeActive(devBase(V1_REF)),
  {},
);
record(
  "MAINT-C mismatch inactive",
  !isDevGlobalMaintenanceModeActive({
    ...devBase(V2_REF),
    SUPABASE_URL: `https://${V1_REF}.supabase.co`,
  }),
  {},
);
record(
  "MAINT-G prod config error",
  resolveDevGlobalMaintenanceState({
    S7_APP_ENV: "production",
    SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    S7_EXPECTED_SUPABASE_PROJECT_REF: PROD_REF,
    DEV_GLOBAL_MAINTENANCE_MODE: "1",
  }).configurationError === true,
  {},
);
record(
  "MAINT-H flag off",
  !isDevGlobalMaintenanceModeActive({ ...devBase(V2_REF), DEV_GLOBAL_MAINTENANCE_MODE: "0" }),
  {},
);

console.log(`PASS ${matrix.length}/${matrix.length} runtime identity gate tests`);
console.log(JSON.stringify({ pass: true, cases: matrix.length }, null, 2));
