#!/usr/bin/env node
/**
 * Missão ASAAS_ENV safety gate + PROD runtime env config + retest (2026-08-18).
 * Sem secrets/PII nos artefatos de saída.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveS7RuntimeEnvironment } from "../src/billing/services/billingRuntimeEnvironmentService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "output");
const DATE = "20260818";
const PROD_REF = "bazibzquasbdgjwdcwbz";
const MAIN_SHA = "1168fbb2f8f3e002af80eb39e4607b22b62254f7";
const PROD_BASE = "https://suse7-backend.vercel.app";

mkdirSync(OUT, { recursive: true });

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i);
    let v = line.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

function subscriptionFingerprint(row) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return [
    row.status,
    row.plan_key,
    row.provider,
    Boolean(meta.internal),
    row.current_period_end ?? "",
    row.next_due_date ?? "",
    Boolean(meta.cancel_at_period_end),
    Boolean(meta.plan_change_at_period_end),
  ].join("|");
}

function hashSuffix(id) {
  return createHash("sha256").update(String(id)).digest("hex").slice(-6);
}

function parsePeriodEnd(value) {
  if (value == null || value === "") return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function readFlags(metadata) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  const sr = m.scheduled_renewal && typeof m.scheduled_renewal === "object" ? m.scheduled_renewal : null;
  return {
    cancel_at_period_end: Boolean(m.cancel_at_period_end),
    plan_change_at_period_end: Boolean(m.plan_change_at_period_end),
    scheduled_renewal_pending: Boolean(sr && !sr.activated_at),
    trial: Boolean(m.trial),
    internal: Boolean(m.internal),
  };
}

async function prodPrecheck(supabase) {
  const now = new Date();
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, status, plan_key, provider, amount, current_period_end, next_due_date, metadata")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];

  let scheduledRenewal = 0;
  let periodExpiration = 0;
  for (const row of rows) {
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const sr = meta.scheduled_renewal && typeof meta.scheduled_renewal === "object" ? meta.scheduled_renewal : null;
    if (sr && !sr.activated_at && sr.period_start_iso) {
      scheduledRenewal += 1;
    }
    const periodEnd = parsePeriodEnd(row.current_period_end);
    const flags = readFlags(meta);
    if (
      periodEnd &&
      periodEnd.getTime() <= now.getTime() &&
      (flags.cancel_at_period_end || flags.plan_change_at_period_end)
    ) {
      periodExpiration += 1;
    }
  }

  const candidateCount = scheduledRenewal + periodExpiration;
  const statusBreakdown = {};
  const providerBreakdown = {};
  for (const r of rows) {
    statusBreakdown[r.status] = (statusBreakdown[r.status] || 0) + 1;
    providerBreakdown[r.provider] = (providerBreakdown[r.provider] || 0) + 1;
  }

  return {
    supabase_ref: PROD_REF,
    subscription_count: rows.length,
    status_breakdown: statusBreakdown,
    provider_breakdown: providerBreakdown,
    subscriptions_sanitized: rows.map((r) => ({
      id_suffix: hashSuffix(r.id),
      status: r.status,
      provider: r.provider,
      plan_key: r.plan_key,
      amount_class: Number(r.amount) > 0 ? "paid" : "zero",
      current_period_end_state:
        parsePeriodEnd(r.current_period_end)?.getTime() > now.getTime() ? "future" : "past_or_null",
      next_due_date_present: Boolean(r.next_due_date),
      metadata_flags: readFlags(r.metadata),
      fingerprint: subscriptionFingerprint(r),
    })),
    candidates: {
      candidate_count_total: candidateCount,
      scheduled_renewal_activation: { count: scheduledRenewal },
      period_expiration: { count: periodExpiration },
    },
    fingerprints: rows.map(subscriptionFingerprint),
  };
}

function buildAsaasEnvAudit() {
  const references = [
    {
      file: "src/billing/services/billingRuntimeEnvironmentService.js",
      function: "resolveS7RuntimeEnvironment / normalizeAsaasEnv",
      category: "runtime guard",
      dev_effect: "Requires ASAAS_ENV=sandbox when S7_APP_ENV=development|staging",
      prod_effect: "Requires ASAAS_ENV=production when S7_APP_ENV=production",
      external_side_effect: "NO — identity validation only; sets financialMutationsAllowed gate",
    },
    {
      file: "src/billing/services/billingPreviewRuntimeGuard.js",
      function: "isBillingFinancialMutationBlocked",
      category: "runtime guard",
      dev_effect: "Blocks billing jobs when env contract invalid",
      prod_effect: "Same — 403 before handler",
      external_side_effect: "NO",
    },
    {
      file: "api/index.js",
      function: "billing job routes guard (788-805)",
      category: "routes",
      dev_effect: "403 when guard fails",
      prod_effect: "Same",
      external_side_effect: "NO",
    },
    {
      file: "src/infra/config.js",
      function: "asaasEnv / asaasApiBaseUrl",
      category: "provider client config",
      dev_effect: "sandbox → api-sandbox.asaas.com/v3",
      prod_effect: "production → api.asaas.com/v3 URL string only",
      external_side_effect: "NO alone — URL selection without API key does not fetch",
    },
    {
      file: "src/billing/providers/AsaasBillingProvider.js",
      function: "assertConfigured / request",
      category: "provider client",
      dev_effect: "Throws ASAAS_API_KEY_REQUIRED before fetch if key missing",
      prod_effect: "Same fail-closed",
      external_side_effect: "CONDITIONAL — only if ASAAS_API_KEY present and method called",
    },
    {
      file: "src/billing/providers/index.js",
      function: "getBillingProvider",
      category: "provider client",
      dev_effect: "Instantiates AsaasBillingProvider (no network)",
      prod_effect: "Same",
      external_side_effect: "NO — constructor only",
    },
    {
      file: "src/handlers/jobs/billingPeriodExpirationsJob.js",
      function: "handleJobsBillingProcessPeriodExpirations",
      category: "jobs",
      dev_effect: "No Asaas import",
      prod_effect: "Same",
      external_side_effect: "NO",
    },
    {
      file: "src/billing/services/billingPeriodExpirationService.js",
      function: "processBillingPeriodExpirations",
      category: "billing service",
      dev_effect: "Supabase-only when candidates exist",
      prod_effect: "Same",
      external_side_effect: "NO Asaas; CONDITIONAL DB writes if candidates > 0",
    },
    {
      file: "src/billing/routes/billingRoutes.js",
      function: "handleBillingRoutes / webhook",
      category: "routes / webhook",
      dev_effect: "Webhook requires ASAAS_WEBHOOK_TOKEN; checkout uses getBillingProvider",
      prod_effect: "Webhook 503 if token missing; no auto-call from ASAAS_ENV alone",
      external_side_effect: "CONDITIONAL — only on explicit HTTP to billing routes with credentials",
    },
    {
      file: "src/billing/utils/billingAsaasWebhookHealth.js",
      function: "buildBillingAsaasWebhookHealthPayload",
      category: "webhook",
      dev_effect: "Reports hasAsaasApiKey false when missing",
      prod_effect: "webhookReady=false without ASAAS_WEBHOOK_TOKEN",
      external_side_effect: "NO",
    },
    {
      file: "src/billing/services/billingAsaasCustomerNotificationPolicyService.js",
      function: "assertAsaasSandboxMutationsAllowed",
      category: "billing service",
      dev_effect: "Blocks non-sandbox Asaas mutations in DEV",
      prod_effect: "Allows when S7_APP_ENV=production + ASAAS_ENV=production but still needs provider calls",
      external_side_effect: "NO alone",
    },
    {
      file: "src/billing/utils/billingRuntimeEnv.js",
      function: "isBillingProductionRuntime",
      category: "runtime guard",
      dev_effect: "Diagnostics flag",
      prod_effect: "Marks production for log suppression",
      external_side_effect: "NO",
    },
    {
      file: "src/handlers/jobs/billingRenewalEngineJob.js",
      category: "jobs",
      function: "uses getBillingProvider",
      dev_effect: "NOT in PROD cron scope this mission",
      prod_effect: "Would need API key for Asaas calls",
      external_side_effect: "OUT_OF_SCOPE — job not executed",
    },
  ];

  const safetyMatrix = {
    A_create_operational_client: {
      answer: "NO",
      note: "getBillingProvider() constructs object; assertConfigured() blocks requests without ASAAS_API_KEY",
      ref: "AsaasBillingProvider.js:31-41",
    },
    B_external_request: {
      answer: "NO",
      note: "request() always calls assertConfigured() first",
      ref: "AsaasBillingProvider.js:49-50",
    },
    C_charge: { answer: "NO", ref: "No charge path without provider.request" },
    D_create_customer: { answer: "NO", ref: "createCustomer → request → assertConfigured" },
    E_create_subscription: { answer: "NO", ref: "createSubscription → request → assertConfigured" },
    F_alter_notificationDisabled: {
      answer: "NO",
      ref: "applyAsaasCustomerNotificationPolicy only on provider mutations",
    },
    G_register_webhook: {
      answer: "NO",
      ref: "No webhook registration code keyed on ASAAS_ENV alone",
    },
    H_emit_nfse: { answer: "NO", ref: "No fiscal module bound to ASAAS_ENV in src/" },
    I_modify_external_financial_state: {
      answer: "NO",
      ref: "Without ASAAS_API_KEY all provider methods fail closed",
    },
  };

  const simulatedProd = resolveS7RuntimeEnvironment({
    S7_APP_ENV: "production",
    ASAAS_ENV: "production",
    S7_EXPECTED_SUPABASE_PROJECT_REF: PROD_REF,
    SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: "prj_82lxqfRgGm33UeWMWvrQt9qe5EwZ",
  });

  return {
    generated_at: new Date().toISOString(),
    ASAAS_ENV_PRODUCTION_SAFE_AS_IDENTITY_MARKER: "YES",
    identity_only: true,
    external_activation: false,
    credential_fail_safe: {
      required_for_asaas_calls: ["ASAAS_API_KEY"],
      optional_url_override: "ASAAS_API_BASE_URL",
      webhook_inbound: "ASAAS_WEBHOOK_TOKEN",
      note: "ASAAS_ENV=production selects api.asaas.com/v3 base URL only; empty ASAAS_API_KEY → ASAAS_API_KEY_REQUIRED",
    },
    references,
    safety_matrix: safetyMatrix,
    simulated_prod_guard_with_identity_only: {
      ok: simulatedProd.ok,
      financial_mutations_allowed: simulatedProd.financialMutationsAllowed,
      reasons: simulatedProd.reasons,
    },
    period_expirations_with_candidate_zero: {
      asaas_requests: 0,
      charge: 0,
      customer_external_mutation: 0,
      fiscal: 0,
      outbound_webhook: 0,
      note: "Job chain has zero Asaas imports; with candidate_count=0 only SELECT scans",
    },
  };
}

async function main() {
  const mode = process.argv[2] || "audit";
  const prodEnvPath =
    process.argv[3] || join(__dirname, "../../_worktrees/suse7-backend-prod-deploy/.env.prod.real");

  if (mode === "audit") {
    const audit = buildAsaasEnvAudit();
    writeFileSync(join(OUT, `ASAAS_ENV_PROD_SAFETY_AUDIT_${DATE}.json`), JSON.stringify(audit, null, 2));
    const md = `# ASAAS_ENV PROD Safety Audit (${DATE})

## Verdict

**ASAAS_ENV_PRODUCTION_SAFE_AS_IDENTITY_MARKER = YES**

Setting \`ASAAS_ENV=production\` without \`ASAAS_API_KEY\` is identity/runtime only. All Asaas HTTP paths fail-closed at \`assertConfigured()\`.

## Safety matrix (A–I)

| Item | Answer |
|------|--------|
| A. operational client | NO |
| B. external request | NO |
| C. charge | NO |
| D. create customer | NO |
| E. create subscription | NO |
| F. notificationDisabled | NO |
| G. register webhook | NO |
| H. NFS-e | NO |
| I. external financial state | NO |

## Period-expirations (candidate_count=0)

Asaas requests = 0. No external side effects expected.

## Gate

Authorizes FASE B (Vercel Production runtime identity vars + redeploy).
`;
    writeFileSync(join(OUT, `ASAAS_ENV_PROD_SAFETY_AUDIT_${DATE}.md`), md);
    console.log("AUDIT_WRITTEN", audit.ASAAS_ENV_PRODUCTION_SAFE_AS_IDENTITY_MARKER);
    return;
  }

  if (mode === "precheck" || mode === "postcheck") {
    const env = loadEnvFile(prodEnvPath);
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const result = await prodPrecheck(supabase);
    const fname =
      mode === "precheck"
        ? `BILLING_PROD_CRON_PRECHECK_AFTER_RUNTIME_${DATE}.json`
        : `BILLING_PROD_CRON_POSTCHECK_AFTER_RUNTIME_${DATE}.json`;
    writeFileSync(join(OUT, fname), JSON.stringify({ generated_at: new Date().toISOString(), ...result }, null, 2));
    console.log(JSON.stringify({ mode, candidate_count: result.candidates.candidate_count_total, subscription_count: result.subscription_count }));
    return;
  }

  if (mode === "probe") {
    const health = await fetchJson(`${PROD_BASE}/api/health`);
    const oauth = await fetchJson(`${PROD_BASE}/api/ml/oauth-config`);
    const asaasHealth = await fetchJson(`${PROD_BASE}/api/billing/webhooks/asaas/health`);
    const guardProbe = await fetchJson(`${PROD_BASE}/api/jobs/billing-process-period-expirations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 50 }),
    });
    const ec = oauth.body?.envCoherence ?? {};
    const payload = {
      generated_at: new Date().toISOString(),
      health_status: health.status,
      oauth: {
        s7AppEnv: ec.s7AppEnv ?? null,
        expectedSupabaseProjectRef: oauth.body?.expectedSupabaseProjectRef ?? ec.expectedSupabaseProjectRef ?? null,
        supabaseProjectRef: oauth.body?.supabaseProjectRef ?? ec.supabaseProjectRef ?? null,
        vercelEnv: oauth.body?.vercelEnv ?? ec.vercelEnv ?? null,
        cross_env: ec.errors?.length ? "YES" : "NO",
      },
      asaas_operational: {
        hasAsaasApiKey: asaasHealth.body?.hasAsaasApiKey ?? null,
        hasAsaasWebhookToken: asaasHealth.body?.hasAsaasWebhookToken ?? null,
        env: asaasHealth.body?.env ?? null,
        webhookReady: asaasHealth.body?.webhookReady ?? null,
      },
      guard_probe_without_secret: {
        http_status: guardProbe.status,
        code: guardProbe.body?.code ?? null,
        reasons: guardProbe.body?.reasons ?? null,
      },
    };
    writeFileSync(join(OUT, `BILLING_PROD_RUNTIME_IDENTITY_PROBE_${DATE}.json`), JSON.stringify(payload, null, 2));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (mode === "job-test") {
    const env = loadEnvFile(prodEnvPath);
    const secret = env.JOB_SECRET || env.S7_PROD_JOB_SECRET || "";
    if (!secret) throw new Error("JOB_SECRET missing in env file");
    const res = await fetchJson(`${PROD_BASE}/api/jobs/billing-process-period-expirations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Job-Secret": secret,
      },
      body: JSON.stringify({ limit: 50 }),
    });
    const out = {
      generated_at: new Date().toISOString(),
      http_status: res.status,
      ok: res.status >= 200 && res.status < 300,
      body: res.body,
      main_sha: MAIN_SHA,
    };
    writeFileSync(join(OUT, `BILLING_PROD_PERIOD_EXPIRATIONS_DIRECT_${DATE}.json`), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ http_status: res.status, ok: out.ok, scanned: res.body?.scanned }));
    return;
  }

  console.error("Unknown mode", mode);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
