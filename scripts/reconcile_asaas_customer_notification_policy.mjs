#!/usr/bin/env node
/**
 * CLI reconciliador — S1.HF.ASAAS-NOTIFICATIONS.1
 *
 * Default: DRY_RUN=1 (sem escrita no Asaas).
 * Para aplicar: DRY_RUN=0 (somente Sandbox + env confirmado).
 *
 * Não cria cobrança / assinatura / Pix / boleto.
 */
import { createClient } from "@supabase/supabase-js";
import { getBillingProvider } from "../src/billing/providers/index.js";
import { reconcileAsaasCustomerNotificationPolicies } from "../src/billing/jobs/billingAsaasCustomerNotificationPolicyReconciler.js";
import { resolveS7RuntimeEnvironment } from "../src/billing/services/billingRuntimeEnvironmentService.js";

const dryRun = String(process.env.DRY_RUN ?? "1") !== "0";
const limit = Number(process.env.LIMIT || 50);
const concurrency = Number(process.env.CONCURRENCY || 2);

const runtime = resolveS7RuntimeEnvironment();
console.log(
  JSON.stringify(
    {
      dryRun,
      s7_app_env: runtime.s7AppEnv,
      asaas_env: runtime.asaasEnv,
      supabase_project_ref: runtime.supabaseProjectRef,
      ok: runtime.ok,
      reasons: runtime.reasons,
    },
    null,
    2
  )
);

if (!runtime.ok && !dryRun) {
  console.error("ABORT: ambiente não confirmado — só dry-run permitido.");
  process.exit(2);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("ABORT: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes.");
  process.exit(2);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const providerApi = getBillingProvider("asaas");

const summary = await reconcileAsaasCustomerNotificationPolicies(supabase, providerApi, {
  dryRun,
  limit,
  concurrency,
});

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exit(1);
