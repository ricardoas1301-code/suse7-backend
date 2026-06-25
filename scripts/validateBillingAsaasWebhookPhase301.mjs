#!/usr/bin/env node
/**
 * Fase 3.0.1 — webhook Asaas → timeline + audit + notifications (in-process).
 * Uso: node scripts/validateBillingAsaasWebhookPhase301.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { handleAsaasWebhookRequest } from "../src/billing/services/billingWebhookService.js";

loadEnv({ path: ".env.local" });
loadEnv();

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN?.trim() || "s7-billing-dev-validate-token";

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

/**
 * @param {Record<string, unknown>} body
 * @param {string} [token]
 */
function makeReq(body, token = webhookToken) {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    url: "/api/billing/webhooks/asaas",
    headers: {
      host: "localhost",
      "asaas-access-token": token,
      "content-type": "application/json",
    },
    bodyBuffer: Buffer.from(raw, "utf8"),
  };
}

/**
 * @param {Record<string, unknown>} body
 */
async function runWebhook(body) {
  return handleAsaasWebhookRequest(supabase, makeReq(body), webhookToken);
}

/**
 * @param {string} eventType
 * @param {string} providerEventId
 * @param {string} paymentId
 * @param {string} providerSubId
 * @param {Record<string, unknown>} [extra]
 */
function paymentBody(eventType, providerEventId, paymentId, providerSubId, extra = {}) {
  return {
    id: providerEventId,
    event: eventType,
    payment: {
      id: paymentId,
      subscription: providerSubId,
      customer: "cus_s7_phase301_validate",
      status: extra.status ?? "CONFIRMED",
      value: 99.9,
      dueDate: "2026-06-13",
      confirmedDate: "2026-05-13",
      billingType: "PIX",
      description: "Suse7 — Fase 3.0.1",
      ...extra,
    },
  };
}

async function pickUserAndPlan() {
  const { data: plan } = await supabase
    .from("plans")
    .select("id, plan_key")
    .eq("is_active", true)
    .eq("billing_required", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const userId = usersData?.users?.[0]?.id ? String(usersData.users[0].id) : null;
  if (!plan?.id || !userId) return null;
  return { userId, planId: String(plan.id), planKey: String(plan.plan_key || "pro") };
}

async function upsertFixture(userId, planId, planKey, providerSubId) {
  await supabase.from("billing_customers").upsert(
    {
      user_id: userId,
      provider: "asaas",
      provider_customer_id: "cus_s7_phase301_validate",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );

  const row = {
    user_id: userId,
    plan_id: planId,
    plan_key: planKey,
    provider: "asaas",
    provider_customer_id: "cus_s7_phase301_validate",
    provider_subscription_id: providerSubId,
    status: "pending",
    amount: 99.9,
    currency: "BRL",
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from("billing_subscriptions")
    .select("id")
    .eq("provider", "asaas")
    .eq("provider_subscription_id", providerSubId)
    .maybeSingle();

  if (existing?.id) {
    await supabase.from("billing_subscriptions").update(row).eq("id", existing.id);
    return String(existing.id);
  }

  const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("id").single();
  if (error) throw error;
  return String(data.id);
}

/**
 * @param {string} userId
 * @param {string} eventType
 * @param {string} [correlationId]
 */
async function countTimeline(userId, eventType, correlationId) {
  let q = supabase
    .from("billing_timeline_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("event_type", eventType);
  if (correlationId) q = q.eq("correlation_id", correlationId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  console.log("=== S7 BILLING Fase 3.0.1 — webhook → timeline ===");

  const meta = await pickUserAndPlan();
  if (!meta) {
    fail("fixture", "usuário/plano indisponível");
    process.exit(1);
  }

  const providerSubId = "sub_s7_phase301_validate";
  const subscriptionId = await upsertFixture(meta.userId, meta.planId, meta.planKey, providerSubId);

  const genEventId = `evt_p301_${randomUUID()}`;
  const genPayId = `pay_p301_${randomUUID()}`;
  const gen = await runWebhook(
    paymentBody("PAYMENT_CREATED", genEventId, genPayId, providerSubId, { status: "PENDING" })
  );
  if (gen.status === 200 && gen.body?.processed) pass("PAYMENT_CREATED webhook");
  else fail("PAYMENT_CREATED webhook", JSON.stringify(gen.body));

  const genTimeline = await countTimeline(meta.userId, "PAYMENT_GENERATED", genEventId);
  if (genTimeline === 1) pass("timeline PAYMENT_GENERATED");
  else fail("timeline PAYMENT_GENERATED", `count=${genTimeline}`);

  const genAudit = await supabase
    .from("billing_audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", meta.userId)
    .eq("correlation_id", genEventId)
    .eq("action", "payment_created");
  if ((genAudit.count ?? 0) >= 1) pass("audit payment_created");
  else fail("audit payment_created", `count=${genAudit.count}`);

  const confEventId = `evt_p301_${randomUUID()}`;
  const confPayId = `pay_p301_${randomUUID()}`;
  const conf = await runWebhook(paymentBody("PAYMENT_CONFIRMED", confEventId, confPayId, providerSubId));
  if (conf.status === 200 && conf.body?.processed) pass("PAYMENT_CONFIRMED webhook");
  else fail("PAYMENT_CONFIRMED webhook", JSON.stringify(conf.body));

  const confTimeline = await countTimeline(meta.userId, "PAYMENT_CONFIRMED", confEventId);
  if (confTimeline === 1) pass("timeline PAYMENT_CONFIRMED");
  else fail("timeline PAYMENT_CONFIRMED", `count=${confTimeline}`);

  const confAudit = await supabase
    .from("billing_audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", meta.userId)
    .eq("correlation_id", confEventId)
    .eq("action", "payment_status_changed");
  if ((confAudit.count ?? 0) >= 1) pass("audit payment_status_changed");
  else fail("audit payment_status_changed", `count=${confAudit.count}`);

  const notify = await supabase
    .from("billing_notification_dispatches")
    .select("id", { count: "exact", head: true })
    .eq("user_id", meta.userId)
    .eq("correlation_id", confEventId);
  if ((notify.count ?? 0) >= 1) pass("notification dispatch (confirmed)");
  else fail("notification dispatch", `count=${notify.count}`);

  const { data: sub } = await supabase
    .from("billing_subscriptions")
    .select("status")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (sub?.status === "active") pass("subscription active após confirmação");
  else fail("subscription active", JSON.stringify(sub));

  const dup = await runWebhook(paymentBody("PAYMENT_CONFIRMED", confEventId, confPayId, providerSubId));
  if (dup.status === 200 && dup.body?.duplicate) pass("webhook idempotente (duplicate)");
  else fail("webhook duplicate", JSON.stringify(dup.body));

  const confTimelineAfterDup = await countTimeline(meta.userId, "PAYMENT_CONFIRMED", confEventId);
  if (confTimelineAfterDup === 1) pass("timeline sem duplicata no reenvio");
  else fail("timeline duplicata", `count=${confTimelineAfterDup}`);

  await supabase
    .from("billing_subscriptions")
    .update({ status: "past_due", metadata: { delinquency_status: "grace" } })
    .eq("id", subscriptionId);

  const reactEventId = `evt_p301_${randomUUID()}`;
  const reactPayId = `pay_p301_${randomUUID()}`;
  const react = await runWebhook(paymentBody("PAYMENT_CONFIRMED", reactEventId, reactPayId, providerSubId));
  if (react.status === 200 && react.body?.processed) pass("PAYMENT_CONFIRMED após past_due");
  else fail("reativação webhook", JSON.stringify(react.body));

  const reactTimeline = await countTimeline(meta.userId, "REACTIVATED", reactEventId);
  if (reactTimeline === 1) pass("timeline REACTIVATED");
  else fail("timeline REACTIVATED", `count=${reactTimeline}`);

  const failEventId = `evt_p301_${randomUUID()}`;
  const failPayId = `pay_p301_${randomUUID()}`;
  await runWebhook(
    paymentBody("PAYMENT_CREATED", `evt_p301_${randomUUID()}`, failPayId, providerSubId, { status: "PENDING" })
  );
  const overdue = await runWebhook(
    paymentBody("PAYMENT_OVERDUE", failEventId, failPayId, providerSubId, { status: "OVERDUE" })
  );
  if (overdue.status === 200 && overdue.body?.processed) pass("PAYMENT_OVERDUE webhook");
  else fail("PAYMENT_OVERDUE", JSON.stringify(overdue.body));

  const failedTimeline = await countTimeline(meta.userId, "PAYMENT_FAILED", failEventId);
  if (failedTimeline === 1) pass("timeline PAYMENT_FAILED");
  else fail("timeline PAYMENT_FAILED", `count=${failedTimeline}`);

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
