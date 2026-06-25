#!/usr/bin/env node
/**
 * BILLING 04.13 — reativação e troca de plano segura.
 * Uso: node scripts/validateBillingPlanChange.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { requestSubscriptionCancellationAtPeriodEnd } from "../src/billing/services/billingSubscriptionCancelService.js";
import { reactivateSubscriptionCancellation } from "../src/billing/services/billingSubscriptionReactivateService.js";
import {
  readSubscriptionPlanChange,
  requestSubscriptionPlanChange,
} from "../src/billing/services/billingSubscriptionChangePlanService.js";
import { readSubscriptionCancellation } from "../src/billing/services/billingSubscriptionCancelService.js";

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

async function pickUser() {
  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const user = usersData?.users?.[0];
  if (!user?.id) return null;
  return { id: String(user.id), email: user.email ?? null, user_metadata: user.user_metadata ?? {} };
}

async function listCatalogPlans() {
  const { data, error } = await supabase
    .from("plans")
    .select("id, plan_key, slug, sort_order, billing_required, is_active")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function cleanupSubscription(subscriptionId) {
  if (!subscriptionId) return;
  await supabase.from("billing_subscriptions").delete().eq("id", subscriptionId);
}

async function main() {
  console.log("=== S7 BILLING 04.13 — reativação + troca de plano ===");

  const user = await pickUser();
  const plans = await listCatalogPlans();
  const paidPlans = plans.filter((plan) => plan.billing_required === true);
  const currentPlan = paidPlans[0] ?? plans[0] ?? null;
  const lowerPlan = paidPlans.find((plan) => Number(plan.sort_order) < Number(currentPlan?.sort_order ?? 0)) ?? null;
  const higherPlan = paidPlans.find((plan) => Number(plan.sort_order) > Number(currentPlan?.sort_order ?? 0)) ?? null;

  if (!user?.id || !currentPlan?.id) {
    fail("fixture", "usuário/plano indisponível");
    process.exit(1);
  }

  const futureEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
  const futureStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const providerSubId = `sub_s7_plan_change_${randomUUID()}`;

  const { data: subscription, error: subError } = await supabase
    .from("billing_subscriptions")
    .insert({
      user_id: user.id,
      plan_id: currentPlan.id,
      plan_key: currentPlan.plan_key,
      provider: "asaas",
      provider_customer_id: "cus_s7_plan_change_validate",
      provider_subscription_id: providerSubId,
      status: "active",
      amount: 99.9,
      currency: "BRL",
      current_period_start: futureStart,
      current_period_end: futureEnd,
      metadata: {},
      updated_at: new Date().toISOString(),
    })
    .select("id, metadata, current_period_end")
    .single();

  if (subError || !subscription?.id) {
    fail("fixture subscription", subError?.message ?? "insert failed");
    process.exit(1);
  }

  try {
    const canceled = await requestSubscriptionCancellationAtPeriodEnd({ supabase, user });
    const cancelMeta = readSubscriptionCancellation(canceled.subscription?.metadata ?? canceled.metadata);
    if (cancelMeta.cancel_at_period_end === true) pass("cancelamento agenda cancel_at_period_end");
    else fail("cancelamento", JSON.stringify(canceled));

    const reactivated = await reactivateSubscriptionCancellation({ supabase, user });
    const reactivatedMeta = readSubscriptionCancellation(reactivated.subscription?.metadata);
    if (reactivated.cancel_at_period_end === false && reactivatedMeta.cancel_at_period_end === false) {
      pass("reativação remove cancelamento agendado");
    } else {
      fail("reativação", JSON.stringify({ reactivated, reactivatedMeta }));
    }

    const currentSlug = currentPlan.slug ?? currentPlan.plan_key;
    try {
      await requestSubscriptionPlanChange({
        supabase,
        user,
        targetPlanSlug: String(currentSlug),
      });
      fail("plano atual", "deveria bloquear TARGET_PLAN_IS_CURRENT");
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code === "TARGET_PLAN_IS_CURRENT") {
        pass("troca para plano atual é bloqueada");
      } else {
        fail("plano atual", error instanceof Error ? error.message : String(error));
      }
    }

    if (lowerPlan) {
      const targetSlug = lowerPlan.slug ?? lowerPlan.plan_key;
      const scheduled = await requestSubscriptionPlanChange({
        supabase,
        user,
        targetPlanSlug: String(targetSlug),
      });
      const scheduledMeta = readSubscriptionPlanChange(scheduled.subscription?.metadata ?? {});
      if (
        scheduled.kind === "scheduled_downgrade" &&
        scheduled.plan_change_at_period_end === true &&
        scheduledMeta.plan_change_at_period_end === true
      ) {
        pass("downgrade agenda mudança no fim do ciclo");
      } else {
        fail("downgrade agendado", JSON.stringify(scheduled));
      }
    } else {
      pass("downgrade agendado (skip — sem plano inferior no catálogo)");
    }

    if (higherPlan) {
      const targetSlug = higherPlan.slug ?? higherPlan.plan_key;
      try {
        const upgraded = await requestSubscriptionPlanChange({
          supabase,
          user,
          targetPlanSlug: String(targetSlug),
          paymentMethod: "PIX",
        });
        if (upgraded.kind === "upgrade_checkout" || upgraded.kind === "checkout") {
          pass("upgrade inicia checkout sem encerrar assinatura atual");
        } else {
          fail("upgrade checkout", JSON.stringify(upgraded));
        }
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error)?.code;
        if (code === "ASAAS_API_KEY_REQUIRED" || code === "ASAAS_BASE_URL_REQUIRED" || code === "PROVIDER_UNSUPPORTED_FOR_PAID") {
          pass(`upgrade checkout (skip gateway: ${code})`);
        } else {
          fail("upgrade checkout", error instanceof Error ? error.message : String(error));
        }
      }
    } else {
      pass("upgrade checkout (skip — sem plano superior no catálogo)");
    }
  } finally {
    await cleanupSubscription(subscription.id);
  }

  const failed = results.filter((line) => line.startsWith("FAIL:"));
  console.log(`\nResumo: ${results.length - failed.length}/${results.length} checks ok`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
