#!/usr/bin/env node
/**
 * BILLING 04.14 — aplicação de downgrade agendado no fim do ciclo.
 * Uso: node scripts/validateBillingScheduledDowngradeExpiration.mjs
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

async function listPaidPlans() {
  const { data, error } = await supabase
    .from("plans")
    .select("id, plan_key, slug, sort_order, billing_required")
    .eq("is_active", true)
    .eq("billing_required", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function cleanupSubscriptions(ids) {
  for (const id of ids) {
    if (!id) continue;
    await supabase.from("billing_subscriptions").delete().eq("id", id);
  }
}

async function validateScheduledPlanDowngrade(userId, plans) {
  const higherPlan = plans[plans.length - 1];
  const lowerPlan = plans.length > 1 ? plans[plans.length - 2] : null;
  if (!higherPlan?.id || !lowerPlan?.id) {
    pass("downgrade agendado (skip — catálogo sem dois planos pagos)");
    return;
  }

  const pastEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pastStart = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const providerSubId = `sub_s7_sched_down_${randomUUID()}`;
  const targetSlug = lowerPlan.slug ?? lowerPlan.plan_key;

  const { data: source, error: sourceError } = await supabase
    .from("billing_subscriptions")
    .insert({
      user_id: userId,
      plan_id: higherPlan.id,
      plan_key: higherPlan.plan_key,
      provider: "asaas",
      provider_customer_id: "cus_s7_sched_down_validate",
      provider_subscription_id: providerSubId,
      status: "active",
      amount: 199.9,
      currency: "BRL",
      current_period_start: pastStart,
      current_period_end: pastEnd,
      next_due_date: pastEnd.slice(0, 10),
      metadata: {
        plan_change_at_period_end: true,
        plan_change_requested_at: pastStart,
        plan_change_target_plan_slug: targetSlug,
        plan_change_target_plan_id: lowerPlan.id,
        plan_change_target_plan_key: lowerPlan.plan_key,
      },
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (sourceError) {
    fail("fixture downgrade agendado", sourceError.message);
    return;
  }

  const sourceId = String(source.id);
  const createdIds = [sourceId];

  try {
    const { count: paymentsBefore } = await supabase
      .from("billing_payments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    const first = await processBillingPeriodExpirations(supabase, { now: new Date() });
    if (first.processed_count >= 1) pass("job aplica downgrade agendado");
    else fail("job downgrade agendado", JSON.stringify(first));

    const { data: sourceAfter } = await supabase
      .from("billing_subscriptions")
      .select("status, metadata")
      .eq("id", sourceId)
      .maybeSingle();
    if (sourceAfter?.status === "canceled") pass("assinatura anterior encerrada");
    else fail("assinatura anterior encerrada", JSON.stringify(sourceAfter));

    const { data: targetRows } = await supabase
      .from("billing_subscriptions")
      .select("id, status, plan_id, plan_key, metadata")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10);
    const target = (targetRows ?? []).find(
      (row) =>
        row.metadata?.downgrade_from_subscription_id === sourceId ||
        row.metadata?.plan_change_from_subscription_id === sourceId
    );
    if (target?.status === "active" && String(target.plan_id) === String(lowerPlan.id)) {
      pass("plano alvo ativo após downgrade agendado");
    } else {
      fail("plano alvo ativo", JSON.stringify(targetRows));
    }
    if (target?.id) createdIds.push(String(target.id));

    const access = await resolveBillingAccess(supabase, userId, { ensureBaby: false });
    if (String(access?.access?.plan_id) === String(lowerPlan.id)) pass("resolveBillingAccess reflete plano alvo");
    else fail("resolveBillingAccess plano alvo", JSON.stringify(access?.access));

    const { data: downgradeEvent } = await supabase
      .from("billing_events")
      .select("id, event_type")
      .eq("provider", "suse7")
      .eq("provider_event_id", `downgrade_to_plan:${sourceId}`)
      .maybeSingle();
    if (downgradeEvent?.event_type === "BILLING_DOWNGRADED_TO_PLAN") pass("evento BILLING_DOWNGRADED_TO_PLAN registrado");
    else fail("evento downgrade para plano", JSON.stringify(downgradeEvent));

    const { count: paymentsAfter } = await supabase
      .from("billing_payments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (paymentsAfter === paymentsBefore) pass("histórico financeiro preservado no downgrade agendado");
    else fail("histórico financeiro downgrade agendado", `before=${paymentsBefore} after=${paymentsAfter}`);

    const second = await processBillingPeriodExpirations(supabase, { now: new Date() });
    const { data: targetRowsAfter } = await supabase
      .from("billing_subscriptions")
      .select("id, metadata")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    const targetCount = (targetRowsAfter ?? []).filter(
      (row) =>
        row.metadata?.downgrade_from_subscription_id === sourceId ||
        row.metadata?.plan_change_from_subscription_id === sourceId
    ).length;
    if (second.processed_count === 0 && targetCount === 1) pass("segunda execução idempotente no downgrade agendado");
    else fail("idempotência downgrade agendado", JSON.stringify({ second, targetCount }));
  } finally {
    await cleanupSubscriptions(createdIds);
  }
}

async function validateCancelToBaby(userId, plans) {
  const plan = plans[0] ?? null;
  if (!plan?.id) {
    fail("cancelamento Baby", "plano pago indisponível");
    return;
  }

  const pastEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pastStart = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const providerSubId = `sub_s7_cancel_baby_${randomUUID()}`;

  const { data: paid, error: paidError } = await supabase
    .from("billing_subscriptions")
    .insert({
      user_id: userId,
      plan_id: plan.id,
      plan_key: plan.plan_key,
      provider: "asaas",
      provider_customer_id: "cus_s7_cancel_baby_validate",
      provider_subscription_id: providerSubId,
      status: "active",
      amount: 99.9,
      currency: "BRL",
      current_period_start: pastStart,
      current_period_end: pastEnd,
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
    fail("fixture cancelamento Baby", paidError.message);
    return;
  }

  const paidId = String(paid.id);
  const createdIds = [paidId];

  try {
    const first = await processBillingPeriodExpirations(supabase, { now: new Date() });
    if (first.processed_count >= 1) pass("cancelamento → Baby continua processando");
    else fail("cancelamento → Baby", JSON.stringify(first));

    const { data: babyRows } = await supabase
      .from("billing_subscriptions")
      .select("id, status, provider, metadata")
      .eq("user_id", userId)
      .eq("provider", "internal")
      .order("created_at", { ascending: false })
      .limit(10);
    const baby = (babyRows ?? []).find((row) => row.metadata?.downgrade_from_subscription_id === paidId);
    if (baby?.status === "internal_free") pass("Baby ativo após cancelamento");
    else fail("Baby após cancelamento", JSON.stringify(babyRows));
    if (baby?.id) createdIds.push(String(baby.id));
  } finally {
    await cleanupSubscriptions(createdIds);
  }
}

async function main() {
  console.log("=== S7 BILLING 04.14 — downgrade agendado no fim do ciclo ===");

  const userId = await pickUserId();
  const plans = await listPaidPlans();
  if (!userId) {
    fail("fixture", "usuário indisponível");
    process.exit(1);
  }

  await validateScheduledPlanDowngrade(userId, plans);
  await validateCancelToBaby(userId, plans);

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
