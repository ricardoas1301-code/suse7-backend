#!/usr/bin/env node
/**
 * Limpeza DEV — deduplica renewal cycles OPEN (Fase 2.1 hardening).
 *
 * Uso:
 *   node scripts/billingPhase21CleanupOpenCycles.mjs
 *   node scripts/billingPhase21CleanupOpenCycles.mjs --email=lojarfmoveis@gmail.com
 *   node scripts/billingPhase21CleanupOpenCycles.mjs --dry-run
 */

import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { createClient } = await import("@supabase/supabase-js");
const { reconcileOpenRenewalCyclesForSubscription } = await import(
  "../src/billing/services/billingRenewalCycleConsistencyService.js"
);
const { RENEWAL_CYCLE_OPEN_STATUSES } = await import("../src/billing/billingConstants.js");

const emailArg = process.argv.find((a) => a.startsWith("--email="));
const email = emailArg ? emailArg.split("=")[1]?.trim().toLowerCase() : null;
const dryRun = process.argv.includes("--dry-run");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function resolveSubscriptionIdsForEmail(targetEmail) {
  const { data: users, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const user = users.users.find((u) => String(u.email || "").toLowerCase() === targetEmail);
  if (!user) throw new Error(`Usuário não encontrado: ${targetEmail}`);

  const { data: subs, error: subErr } = await supabase
    .from("billing_subscriptions")
    .select("id")
    .eq("user_id", user.id);
  if (subErr) throw subErr;
  return (subs ?? []).map((s) => String(s.id));
}

async function listSubscriptionIdsWithDuplicateOpenCycles() {
  const { data, error } = await supabase
    .from("billing_renewal_cycles")
    .select("subscription_id, renewal_status")
    .in("renewal_status", [...RENEWAL_CYCLE_OPEN_STATUSES]);
  if (error) throw error;

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const row of data ?? []) {
    const sid = String(row.subscription_id);
    counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([sid]) => sid);
}

async function main() {
  let subscriptionIds = await listSubscriptionIdsWithDuplicateOpenCycles();

  if (email) {
    const scoped = await resolveSubscriptionIdsForEmail(email);
    subscriptionIds = subscriptionIds.filter((id) => scoped.includes(id));
    for (const id of scoped) {
      if (!subscriptionIds.includes(id)) subscriptionIds.push(id);
    }
  }

  if (subscriptionIds.length === 0) {
    console.info("[BILLING TEST] cleanup_open_cycles", {
      message: "Nenhuma assinatura com ciclos OPEN duplicados.",
      dry_run: dryRun,
      email: email ?? "all",
    });
    return;
  }

  let totalSuperseded = 0;
  for (const subscriptionId of subscriptionIds) {
    const result = await reconcileOpenRenewalCyclesForSubscription(supabase, subscriptionId, {
      reason: "dev_cleanup_script",
      dryRun,
    });
    totalSuperseded += result.supersededCycleIds.length;
    console.info("[BILLING TEST] cleanup_subscription", {
      subscription_id: subscriptionId,
      open_cycles_count: result.openCyclesCount,
      canonical_cycle_id: result.canonicalCycle?.id ?? null,
      superseded_cycle_ids: result.supersededCycleIds,
      resolution_strategy: result.resolutionStrategy,
      dry_run: dryRun,
    });
  }

  console.info("[BILLING TEST] cleanup_complete", {
    subscriptions_processed: subscriptionIds.length,
    superseded_total: totalSuperseded,
    dry_run: dryRun,
  });
}

main().catch((err) => {
  console.error("[BILLING TEST] cleanup_failed", { error_message: err?.message });
  process.exit(1);
});
