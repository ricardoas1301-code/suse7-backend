#!/usr/bin/env node
/**
 * BILLING 04.11 — validação de expiração de ciclo e downgrade para Baby.
 * Uso: node scripts/validateBillingPeriodExpiration.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { processBillingPeriodExpirations } from "../src/billing/services/billingPeriodExpirationService.js";
import { resolveBillingAccess } from "../src/billing/services/resolveBillingAccess.js";

loadEnv({ path: ".env.local" });
loadEnv();

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl || !serviceKey) {
  console.error("Falta SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** @type {string[]} */
const results = [];

function pass(msg) {
  results.push(`PASS: ${msg}`);
  console.log(`PASS: ${msg}`);
}

function fail(msg, detail) {
  const line = detail ? `FAIL: ${msg} — ${detail}` : `FAIL: ${msg}`;
  results.push(line);
  console.error(line);
}

async function pickUserId() {
  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  return usersData?.users?.[0]?.id ? String(usersData.users[0].id) : null;
}

async function pickPaidPlan() {
  const { data: plan } = await supabase
    .from("plans")
    .select("id, plan_key, billing_required")
    .eq("is_active", true)
    .eq("billing_required", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (plan?.id) return plan;
  const { data: fallback } = await supabase
    .from("plans")
    .select("id, plan_key, billing_required")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  return fallback ?? null;
}

async function main() {
  console.log("=== S7 BILLING 04.11 — expiração de ciclo + downgrade Baby ===");

  const userId = await pickUserId();
  const plan = await pickPaidPlan();
  if (!userId || !plan?.id) {
    fail("fixture", "usuário/plano indisponível");
    process.exit(1);
  }

  const providerSubId = `sub_s7_period_exp_${randomUUID()}`;
  const pastEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pastStart = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

  const { data: paid, error: paidError } = await supabase
    .from("billing_subscriptions")
    .insert({
      user_id: userId,
      plan_id: plan.id,
      plan_key: plan.plan_key,
      provider: "asaas",
      provider_customer_id: "cus_s7_period_exp_validate",
      provider_subscription_id: providerSubId,
      status: "active",
      amount: 99.9,
      currency: "BRL",
      current_period_start: pastStart,
      current_period_end: pastEnd,
      next_due_date: pastEnd.slice(0, 10),
      metadata: {
        cancel_at_period_end: true,
        cancel_requested_at: pastStart,
        downgrade_target_plan_key: "baby",
        downgrade_scheduled: true,
      },
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (paidError) {
    fail("fixture paid subscription", paidError.message);
    process.exit(1);
  }

  const paidId = String(paid.id);
  const { count: paymentsBefore } = await supabase
    .from("billing_payments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const first = await processBillingPeriodExpirations(supabase, { now: new Date() });
  if (first.processed_count === 1) pass("job processou 1 assinatura elegível");
  else fail("job primeira execução", JSON.stringify(first));

  const { data: paidAfter } = await supabase
    .from("billing_subscriptions")
    .select("status, metadata")
    .eq("id", paidId)
    .maybeSingle();
  if (paidAfter?.status === "canceled") pass("assinatura paga encerrada como canceled");
  else fail("assinatura paga encerrada", JSON.stringify(paidAfter));

  const { data: babyRows } = await supabase
    .from("billing_subscriptions")
    .select("id, status, provider, plan_key, metadata")
    .eq("user_id", userId)
    .eq("provider", "internal")
    .order("created_at", { ascending: false })
    .limit(5);
  const baby = (babyRows ?? []).find((row) => row.metadata?.downgrade_from_subscription_id === paidId);
  if (baby?.status === "internal_free") pass("Baby ativo após downgrade");
  else fail("Baby ativo", JSON.stringify(babyRows));

  const access = await resolveBillingAccess(supabase, userId, { ensureBaby: false });
  if (access?.access?.state === "internal_free" || access?.access?.can_access === true) pass("resolveBillingAccess reflete Baby");
  else fail("resolveBillingAccess Baby", JSON.stringify(access?.access));

  const { data: downgradeEvent } = await supabase
    .from("billing_events")
    .select("id, event_type")
    .eq("provider", "suse7")
    .eq("provider_event_id", `downgrade:${paidId}`)
    .maybeSingle();
  if (downgradeEvent?.event_type === "BILLING_DOWNGRADED_TO_BABY") pass("evento BILLING_DOWNGRADED_TO_BABY registrado");
  else fail("evento downgrade", JSON.stringify(downgradeEvent));

  const { count: paymentsAfter } = await supabase
    .from("billing_payments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (paymentsAfter === paymentsBefore) pass("histórico financeiro preservado");
  else fail("histórico financeiro", `before=${paymentsBefore} after=${paymentsAfter}`);

  const second = await processBillingPeriodExpirations(supabase, { now: new Date() });
  const babyCount = (babyRows ?? []).filter((row) => row.metadata?.downgrade_from_subscription_id === paidId).length;
  const { data: babyRowsAfter } = await supabase
    .from("billing_subscriptions")
    .select("id, metadata")
    .eq("user_id", userId)
    .eq("provider", "internal");
  const babyCountAfter = (babyRowsAfter ?? []).filter((row) => row.metadata?.downgrade_from_subscription_id === paidId).length;
  if (second.processed_count === 0 && babyCountAfter === babyCount) pass("segunda execução idempotente");
  else fail("idempotência segunda execução", JSON.stringify({ second, babyCountAfter, babyCount }));

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
