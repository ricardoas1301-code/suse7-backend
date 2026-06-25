#!/usr/bin/env node
/**
 * BILLING 04.9 — validação E2E checkout + webhook Asaas (handler in-process).
 * Uso: node scripts/validateBillingCheckoutWebhookE2e.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { handleAsaasWebhookRequest } from "../src/billing/services/billingWebhookService.js";
import { listSellerPaymentHistory } from "../src/billing/services/billingPaymentsHistoryService.js";
import { resolveBillingAccess } from "../src/billing/services/resolveBillingAccess.js";

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
 * @param {string} token
 */
function makeReq(body, token) {
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
 * @param {string} [token]
 */
async function runWebhook(body, token = webhookToken) {
  const req = makeReq(body, token);
  return handleAsaasWebhookRequest(supabase, req, token);
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
      customer: "cus_s7_e2e_validate",
      status: eventType.replace("PAYMENT_", ""),
      value: 99.9,
      dueDate: "2026-06-13",
      confirmedDate: "2026-05-13",
      billingType: "PIX",
      description: "Suse7 — plano pago",
      ...extra,
    },
  };
}

/**
 * @param {string} eventType
 * @param {string} providerEventId
 * @param {string} providerSubId
 */
function subscriptionBody(eventType, providerEventId, providerSubId) {
  return {
    id: providerEventId,
    event: eventType,
    subscription: {
      id: providerSubId,
      customer: "cus_s7_e2e_validate",
      status: eventType.includes("DELETED") || eventType.includes("INACTIVATED") ? "INACTIVE" : "ACTIVE",
      nextDueDate: "2026-06-13",
      dateCreated: "2026-05-13",
    },
  };
}

async function pickPaidPlanAndUser() {
  const { data: plan } = await supabase
    .from("plans")
    .select("id, plan_key, billing_required")
    .eq("is_active", true)
    .eq("billing_required", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!plan?.id) {
    const { data: fallback } = await supabase
      .from("plans")
      .select("id, plan_key, billing_required")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!fallback?.id) return null;
    return { planId: String(fallback.id), planKey: String(fallback.plan_key || ""), userId: await pickUserId() };
  }
  return { planId: String(plan.id), planKey: String(plan.plan_key || ""), userId: await pickUserId() };
}

async function pickUserId() {
  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const userId = usersData?.users?.[0]?.id ? String(usersData.users[0].id) : null;
  return userId;
}

async function upsertFixture(userId, planId, planKey, providerSubId) {
  await supabase.from("billing_customers").upsert(
    {
      user_id: userId,
      provider: "asaas",
      provider_customer_id: "cus_s7_e2e_validate",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );

  const row = {
    user_id: userId,
    plan_id: planId,
    plan_key: planKey,
    provider: "asaas",
    provider_customer_id: "cus_s7_e2e_validate",
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

async function subscriptionStatus(subscriptionId) {
  const { data } = await supabase.from("billing_subscriptions").select("status, current_period_start, current_period_end, next_due_date, canceled_at").eq("id", subscriptionId).maybeSingle();
  return data ?? null;
}

async function main() {
  console.log("=== S7 BILLING 04.9 — checkout + webhook E2E ===");

  const fixtureMeta = await pickPaidPlanAndUser();
  if (!fixtureMeta?.userId) {
    fail("fixture", "plano/usuário indisponível");
    process.exit(1);
  }

  const providerSubId = "sub_s7_e2e_checkout_validate";
  const subscriptionId = await upsertFixture(fixtureMeta.userId, fixtureMeta.planId, fixtureMeta.planKey, providerSubId);

  const createdEventId = `evt_e2e_${randomUUID()}`;
  const createdPayId = `pay_e2e_${randomUUID()}`;
  const created = await runWebhook(
    paymentBody("PAYMENT_CREATED", createdEventId, createdPayId, providerSubId, { status: "PENDING" })
  );
  if (created.status === 200 && created.body?.processed === true) pass("PAYMENT_CREATED processado");
  else fail("PAYMENT_CREATED", JSON.stringify(created.body));

  const { data: createdPay } = await supabase
    .from("billing_payments")
    .select("id, status")
    .eq("provider", "asaas")
    .eq("provider_payment_id", createdPayId)
    .maybeSingle();
  if (createdPay?.id) pass("billing_payments registrou PAYMENT_CREATED");
  else fail("billing_payments PAYMENT_CREATED", "linha ausente");

  const historyPending = await listSellerPaymentHistory(supabase, fixtureMeta.userId);
  if (historyPending.some((row) => row.provider_payment_id === createdPayId && row.status === "pending")) {
    pass("histórico lista cobrança pendente");
  } else {
    fail("histórico pendente", JSON.stringify(historyPending.slice(0, 3)));
  }

  const subAfterCreated = await subscriptionStatus(subscriptionId);
  if (subAfterCreated?.status === "pending") pass("PAYMENT_CREATED mantém assinatura pendente");
  else fail("PAYMENT_CREATED status assinatura", JSON.stringify(subAfterCreated));

  const confirmedEventId = `evt_e2e_${randomUUID()}`;
  const confirmedPayId = `pay_e2e_${randomUUID()}`;
  const confirmed = await runWebhook(paymentBody("PAYMENT_CONFIRMED", confirmedEventId, confirmedPayId, providerSubId));
  if (confirmed.status === 200 && confirmed.body?.processed === true) pass("PAYMENT_CONFIRMED processado");
  else fail("PAYMENT_CONFIRMED", JSON.stringify(confirmed.body));

  const subAfterConfirmed = await subscriptionStatus(subscriptionId);
  if (subAfterConfirmed?.status === "active") pass("PAYMENT_CONFIRMED -> active");
  else fail("PAYMENT_CONFIRMED -> active", JSON.stringify(subAfterConfirmed));
  if (subAfterConfirmed?.current_period_start && subAfterConfirmed?.current_period_end) {
    pass("PAYMENT_CONFIRMED atualiza ciclo da assinatura");
  } else {
    fail("ciclo após PAYMENT_CONFIRMED", JSON.stringify(subAfterConfirmed));
  }

  const accessAfterConfirm = await resolveBillingAccess(supabase, fixtureMeta.userId);
  if (accessAfterConfirm?.can_access === true) pass("resolveBillingAccess libera acesso após confirmação");
  else fail("resolveBillingAccess após confirmação", JSON.stringify(accessAfterConfirm?.access));

  const dup = await runWebhook(paymentBody("PAYMENT_CONFIRMED", confirmedEventId, confirmedPayId, providerSubId));
  if (dup.status === 200 && dup.body?.duplicate === true) pass("reenvio duplicate: true");
  else fail("idempotência webhook", JSON.stringify(dup.body));

  const received = await runWebhook(
    paymentBody("PAYMENT_RECEIVED", `evt_e2e_${randomUUID()}`, `pay_e2e_${randomUUID()}`, providerSubId)
  );
  if (received.status === 200 && received.body?.processed === true) pass("PAYMENT_RECEIVED processado");
  else fail("PAYMENT_RECEIVED", JSON.stringify(received.body));

  const overdue = await runWebhook(
    paymentBody("PAYMENT_OVERDUE", `evt_e2e_${randomUUID()}`, `pay_e2e_${randomUUID()}`, providerSubId, {
      status: "OVERDUE",
      dueDate: "2026-05-01",
    })
  );
  if (overdue.status === 200 && overdue.body?.processed === true) pass("PAYMENT_OVERDUE processado");
  else fail("PAYMENT_OVERDUE", JSON.stringify(overdue.body));
  const subAfterOverdue = await subscriptionStatus(subscriptionId);
  if (subAfterOverdue?.status === "past_due") pass("PAYMENT_OVERDUE -> past_due");
  else fail("PAYMENT_OVERDUE -> past_due", JSON.stringify(subAfterOverdue));

  await supabase.from("billing_subscriptions").update({ status: "active", canceled_at: null }).eq("id", subscriptionId);
  const deletedPayId = `pay_e2e_${randomUUID()}`;
  const deletedEventId = `evt_e2e_${randomUUID()}`;
  const paymentDeleted = await runWebhook(
    paymentBody("PAYMENT_DELETED", deletedEventId, deletedPayId, providerSubId, { status: "DELETED" })
  );
  if (paymentDeleted.status === 200 && paymentDeleted.body?.processed === true) pass("PAYMENT_DELETED processado");
  else fail("PAYMENT_DELETED", JSON.stringify(paymentDeleted.body));
  const subAfterPaymentDeleted = await subscriptionStatus(subscriptionId);
  if (subAfterPaymentDeleted?.status === "active") pass("PAYMENT_DELETED não cancela assinatura ativa");
  else fail("PAYMENT_DELETED preserva assinatura", JSON.stringify(subAfterPaymentDeleted));

  const subCreated = await runWebhook(subscriptionBody("SUBSCRIPTION_CREATED", `evt_e2e_${randomUUID()}`, providerSubId));
  if (subCreated.status === 200 && subCreated.body?.processed === true) pass("SUBSCRIPTION_CREATED processado");
  else fail("SUBSCRIPTION_CREATED", JSON.stringify(subCreated.body));

  const subUpdated = await runWebhook(subscriptionBody("SUBSCRIPTION_UPDATED", `evt_e2e_${randomUUID()}`, providerSubId));
  if (subUpdated.status === 200 && subUpdated.body?.processed === true) pass("SUBSCRIPTION_UPDATED processado");
  else fail("SUBSCRIPTION_UPDATED", JSON.stringify(subUpdated.body));

  const subDeleted = await runWebhook(subscriptionBody("SUBSCRIPTION_DELETED", `evt_e2e_${randomUUID()}`, providerSubId));
  if (subDeleted.status === 200 && subDeleted.body?.processed === true) pass("SUBSCRIPTION_DELETED processado");
  else fail("SUBSCRIPTION_DELETED", JSON.stringify(subDeleted.body));
  const subAfterDeleted = await subscriptionStatus(subscriptionId);
  if (subAfterDeleted?.status === "canceled" && subAfterDeleted?.canceled_at) pass("SUBSCRIPTION_DELETED -> canceled");
  else fail("SUBSCRIPTION_DELETED -> canceled", JSON.stringify(subAfterDeleted));

  console.log("\n--- checklist manual ---");
  console.log("1. Baby escolhe plano pago em /perfil/assinatura/planos");
  console.log("2. Checkout retorna link/PIX");
  console.log("3. billing_payments/billing_subscriptions recebem a cobrança");
  console.log("4. /perfil/assinatura/historico mostra pendente");
  console.log("5. Webhook PAYMENT_CONFIRMED/RECEIVED no Asaas");
  console.log("6. GET /api/billing/subscription/status retorna plano pago ativo");
  console.log("7. Minha assinatura e Planos refletem o novo plano");

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
