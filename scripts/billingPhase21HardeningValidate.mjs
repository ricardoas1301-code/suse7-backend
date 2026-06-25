#!/usr/bin/env node
/**
 * Revalidação pós-hardening — garante ≤1 ciclo OPEN por assinatura após cada cenário.
 *
 * Uso:
 *   node scripts/billingPhase21HardeningValidate.mjs --email=lojarfmoveis@gmail.com
 */

import dotenv from "dotenv";
import { spawn } from "node:child_process";

dotenv.config({ path: ".env.local" });
dotenv.config();

const email = process.argv.find((a) => a.startsWith("--email="))?.split("=")[1]?.trim().toLowerCase();
if (!email) {
  console.error("Uso: node scripts/billingPhase21HardeningValidate.mjs --email=<seller@email.com>");
  process.exit(1);
}

process.env.BILLING_RENEWAL_TEST_ACCELERATED = "1";

const { createClient } = await import("@supabase/supabase-js");
const { listOpenRenewalCyclesForSubscription } = await import(
  "../src/billing/services/billingRenewalCycleConsistencyService.js"
);
const { getBillingProvider } = await import("../src/billing/providers/index.js");
const { processBillingRenewalEngine } = await import("../src/billing/services/billingRenewalEngine.js");

const scenarios = ["active", "warning", "danger", "critical", "grace", "suspended"];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function runScenarioScript(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/billingPhase21AcceleratedScenario.mjs",
        `--email=${email}`,
        `--scenario=${scenario}`,
      ],
      { cwd: process.cwd(), stdio: "inherit", env: process.env }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`scenario_${scenario}_exit_${code}`))));
  });
}

async function findActiveSubscriptionId() {
  const { data: users, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const user = users.users.find((u) => String(u.email || "").toLowerCase() === email);
  if (!user) throw new Error(`seller_not_found:${email}`);

  const { data: subs, error: subErr } = await supabase
    .from("billing_subscriptions")
    .select("id, status")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (subErr) throw subErr;

  const active =
    subs?.find((s) => String(s.status).toLowerCase() === "active") ??
    subs?.find((s) => String(s.provider).toLowerCase() === "asaas") ??
    subs?.[0];
  if (!active?.id) throw new Error("no_subscription");
  return String(active.id);
}

async function countOpen(subscriptionId) {
  const rows = await listOpenRenewalCyclesForSubscription(supabase, subscriptionId);
  return rows;
}

async function main() {
  const subscriptionId = await findActiveSubscriptionId();
  const providerApi = getBillingProvider(process.env.BILLING_PROVIDER_DEFAULT || "asaas");
  /** @type {Array<Record<string, unknown>>} */
  const results = [];

  for (const scenario of scenarios) {
    await runScenarioScript(scenario);
    await processBillingRenewalEngine(supabase, {
      providerApi,
      limit: 20,
      now: new Date(),
    });
    const open = await countOpen(subscriptionId);
    const pass = open.length <= 1;
    results.push({
      scenario,
      pass,
      open_cycles_count: open.length,
      cycle_ids: open.map((r) => r.id),
      statuses: open.map((r) => r.renewal_status),
    });
    console.info("[BILLING TEST] hardening_check", results[results.length - 1]);
    if (!pass) {
      console.error("[BILLING TEST] hardening_failed", { scenario, open_cycles_count: open.length });
      process.exit(1);
    }
  }

  await runScenarioScript("restore");
  const openAfterRestore = await countOpen(subscriptionId);
  console.info("[BILLING TEST] hardening_restore", {
    open_cycles_count: openAfterRestore.length,
    cycle_ids: openAfterRestore.map((r) => r.id),
  });

  console.info("[BILLING TEST] hardening_validate_ok", {
    email,
    subscription_id: subscriptionId,
    scenarios_passed: results.length,
  });
}

main().catch((err) => {
  console.error("[BILLING TEST] hardening_validate_failed", { error_message: err?.message });
  process.exit(1);
});
