#!/usr/bin/env node
/**
 * BILLING 04.12 — validação de inadimplência e grace period.
 * Uso: node scripts/validateBillingDunning.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  applyPaymentOverdueDelinquency,
  applyPaymentRecoveryDelinquency,
  processBillingOverdues,
  readSubscriptionDelinquency,
} from "../src/billing/services/billingDunningService.js";
import { canUserAccessPlanFeatures } from "../src/billing/services/billingAccessService.js";

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

async function main() {
  console.log("=== S7 BILLING 04.12 — inadimplência + grace period ===");

  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const userId = usersData?.users?.[0]?.id ? String(usersData.users[0].id) : null;
  const { data: plan } = await supabase
    .from("plans")
    .select("id, plan_key")
    .eq("is_active", true)
    .eq("billing_required", true)
    .limit(1)
    .maybeSingle();
  if (!userId || !plan?.id) {
    fail("fixture", "usuário/plano indisponível");
    process.exit(1);
  }

  const providerSubId = `sub_s7_dunning_${randomUUID()}`;
  const { data: sub, error: subError } = await supabase
    .from("billing_subscriptions")
    .insert({
      user_id: userId,
      plan_id: plan.id,
      plan_key: plan.plan_key,
      provider: "asaas",
      provider_customer_id: "cus_s7_dunning_validate",
      provider_subscription_id: providerSubId,
      status: "active",
      amount: 99.9,
      currency: "BRL",
      metadata: {},
      updated_at: new Date().toISOString(),
    })
    .select("id, metadata")
    .single();
  if (subError) {
    fail("fixture subscription", subError.message);
    process.exit(1);
  }

  const paymentId = `pay_s7_dunning_${randomUUID()}`;
  await applyPaymentOverdueDelinquency(supabase, {
    providerSubscriptionId: providerSubId,
    paymentId,
    nextDueDate: "2026-05-01",
  });

  const { data: overdueSub } = await supabase
    .from("billing_subscriptions")
    .select("status, metadata")
    .eq("id", sub.id)
    .maybeSingle();
  const overdueMeta = readSubscriptionDelinquency(overdueSub?.metadata);
  if (overdueSub?.status === "past_due" && overdueMeta.delinquency_status === "grace") {
    pass("PAYMENT_OVERDUE inicia grace period");
  } else {
    fail("PAYMENT_OVERDUE grace", JSON.stringify({ overdueSub, overdueMeta }));
  }

  const accessGrace = await canUserAccessPlanFeatures(supabase, userId);
  if (accessGrace.can_access === true && accessGrace.delinquency_warning === true) {
    pass("grace period mantém can_access=true com aviso");
  } else {
    fail("can_access no grace", JSON.stringify(accessGrace));
  }

  const pastGrace = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  await supabase
    .from("billing_subscriptions")
    .update({
      metadata: {
        ...overdueMeta,
        delinquency_status: "grace",
        grace_period_ends_at: new Date(Date.now() - 60 * 1000).toISOString(),
        overdue_since: overdueMeta.overdue_since,
      },
    })
    .eq("id", sub.id);

  const suspended = await processBillingOverdues(supabase, { now: pastGrace });
  if (suspended.processed_count >= 1) pass("processBillingOverdues suspende após grace");
  else fail("processBillingOverdues", JSON.stringify(suspended));

  const accessSuspended = await canUserAccessPlanFeatures(supabase, userId);
  if (accessSuspended.can_access === false) pass("após grace period can_access=false");
  else fail("can_access após grace", JSON.stringify(accessSuspended));

  await applyPaymentRecoveryDelinquency(supabase, {
    providerSubscriptionId: providerSubId,
    paymentId,
    nextDueDate: "2026-06-13",
    paidAt: new Date().toISOString(),
  });

  const { data: recoveredSub } = await supabase
    .from("billing_subscriptions")
    .select("status, metadata")
    .eq("id", sub.id)
    .maybeSingle();
  const recoveredMeta = readSubscriptionDelinquency(recoveredSub?.metadata);
  if (recoveredSub?.status === "active" && recoveredMeta.delinquency_status === "none") {
    pass("pagamento confirmado recupera assinatura");
  } else {
    fail("recuperação", JSON.stringify({ recoveredSub, recoveredMeta }));
  }

  const accessRecovered = await canUserAccessPlanFeatures(supabase, userId);
  if (accessRecovered.can_access === true && accessRecovered.state === "active") {
    pass("can_access volta após recuperação");
  } else {
    fail("can_access recuperado", JSON.stringify(accessRecovered));
  }

  const { data: recoveredEvent } = await supabase
    .from("billing_events")
    .select("event_type")
    .eq("provider", "suse7")
    .eq("provider_event_id", `recovered:${sub.id}:${paymentId}`)
    .maybeSingle();
  if (recoveredEvent?.event_type === "SUBSCRIPTION_RECOVERED") pass("evento SUBSCRIPTION_RECOVERED registrado");
  else fail("evento SUBSCRIPTION_RECOVERED", JSON.stringify(recoveredEvent));

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
