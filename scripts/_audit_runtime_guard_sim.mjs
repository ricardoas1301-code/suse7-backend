#!/usr/bin/env node
/** Simulate billing runtime guard from Vercel env — never prints secret values. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveS7RuntimeEnvironment,
  S7_SUPABASE_PROJECT_REF,
  S7_VERCEL_PROJECT_ID,
} from "../src/billing/services/billingRuntimeEnvironmentService.js";

const GUARD_KEYS = [
  "S7_APP_ENV",
  "ASAAS_ENV",
  "S7_EXPECTED_SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "BILLING_PREVIEW_MUTATIONS_ENABLED",
  "JOB_SECRET",
];

function readVercelToken() {
  const authPath = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "com.vercel.cli",
    "Data",
    "auth.json"
  );
  return JSON.parse(fs.readFileSync(authPath, "utf8")).token;
}

function statusPresent(val) {
  return val != null && String(val).trim() !== "" ? "PRESENT" : "EMPTY";
}

function refFromUrl(url) {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url || "").trim());
  return m?.[1]?.toLowerCase() || null;
}

async function buildSim(projectId, label) {
  const token = readVercelToken();
  const res = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env?decrypt=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const entries = (await res.json()).envs || [];
  /** @type {Record<string, string>} */
  const prod = { VERCEL_ENV: "production", VERCEL_PROJECT_ID: projectId };
  for (const k of GUARD_KEYS) {
    const e = entries.find((x) => x.key === k && (x.target || []).includes("production"));
    if (e) prod[k] = String(e.value ?? e.decryptedValue ?? "").trim();
  }
  const runtime = resolveS7RuntimeEnvironment(prod);
  return {
    label,
    projectId,
    env_status_production: Object.fromEntries(GUARD_KEYS.map((k) => [k, statusPresent(prod[k])])),
    derived_supabase_ref_from_url: refFromUrl(prod.SUPABASE_URL),
    runtime_ok: runtime.ok,
    financial_mutations_allowed: runtime.financialMutationsAllowed,
    reasons: runtime.reasons,
    s7_app_env_normalized: runtime.s7AppEnv,
    asaas_env_normalized: runtime.asaasEnv,
    expected_ref: runtime.expectedSupabaseProjectRef,
    actual_ref: runtime.supabaseProjectRef,
  };
}

const sims = [];
for (const [label, id] of Object.entries(S7_VERCEL_PROJECT_ID)) {
  sims.push(await buildSim(id, label));
}

console.log(
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      known_refs: S7_SUPABASE_PROJECT_REF,
      simulations_production_scope: sims,
      prod_live_probe_reasons: [
        "S7_APP_ENV_ABSENT",
        "ASAAS_ENV_ABSENT",
        "SUPABASE_EXPECTED_PROJECT_REF_ABSENT",
      ],
    },
    null,
    2
  )
);
