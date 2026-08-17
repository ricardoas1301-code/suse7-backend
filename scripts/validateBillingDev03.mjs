#!/usr/bin/env node
/**
 * Validação operacional BILLING 03 (DEV) — Supabase + handler webhook.
 * Uso: node scripts/validateBillingDev03.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { handleAsaasWebhookRequest } from "../src/billing/services/billingWebhookService.js";
import { canUserAccessPlanFeatures } from "../src/billing/planAccessService.js";

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
 * @param {import("http").ServerResponse} res
 */
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

async function ensureSchema() {
  const { data: events, error: eventsErr } = await supabase.from("billing_events").select("id").limit(1);
  if (eventsErr) {
    fail("billing_events acessível", eventsErr.message);
    return false;
  }
  pass("billing_events acessível");

  const { data: subs, error: subsErr } = await supabase
    .from("billing_subscriptions")
    .select("plan_key, current_period_start, current_period_end, next_due_date, canceled_at")
    .limit(1);
  if (subsErr) {
    fail("billing_subscriptions colunas novas", subsErr.message);
    return false;
  }
  pass("billing_subscriptions com colunas de ciclo/plano");
  return true;
}

async function pickPlanAndUser() {
  const { data: plan, error: planErr } = await supabase
    .from("plans")
    .select("id, plan_key")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (planErr || !plan?.id) {
    fail("plano ativo para fixture", planErr?.message || "nenhum plano");
    return null;
  }

  const { data: usersData, error: usersErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const userId = usersData?.users?.[0]?.id ? String(usersData.users[0].id) : null;
  if (usersErr || !userId) {
    fail("usuário auth para fixture", usersErr?.message || "sem usuários");
    return null;
  }

  return { planId: String(plan.id), planKey: String(plan.plan_key || ""), userId };
}

async function upsertFixtureSubscription(userId, planId, planKey, providerSubscriptionId) {
  const { data: existing } = await supabase
    .from("billing_subscriptions")
    .select("id")
    .eq("provider", "asaas")
    .eq("provider_subscription_id", providerSubscriptionId)
    .maybeSingle();

  const row = {
    user_id: userId,
    plan_id: planId,
    plan_key: planKey || null,
    provider: "asaas",
    provider_customer_id: "cus_s7_dev_validate",
    provider_subscription_id: providerSubscriptionId,
    status: "pending",
    amount: 19.9,
    currency: "BRL",
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await supabase.from("billing_subscriptions").update(row).eq("id", existing.id);
    if (error) throw error;
    return String(existing.id);
  }

  const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("id").single();
  if (error) throw error;
  return String(data.id);
}

async function runWebhook(body, token = webhookToken) {
  const req = makeReq(body, token);
  const res = makeRes();
  const out = await handleAsaasWebhookRequest(supabase, req, token);
  return { out, res };
}

async function main() {
  console.log("=== S7 BILLING 03 — validação DEV ===");

  const schemaOk = await ensureSchema();
  if (!schemaOk) process.exit(1);

  const fixture = await pickPlanAndUser();
  if (!fixture) process.exit(1);

  const providerSubId = "sub_s7_dev_validate";
  const subscriptionId = await upsertFixtureSubscription(
    fixture.userId,
    fixture.planId,
    fixture.planKey,
    providerSubId
  );

  const eventId = `evt_s7_dev_${randomUUID()}`;
  const paymentId = `pay_s7_dev_${randomUUID()}`;

  const paymentPayload = {
    id: eventId,
    event: "PAYMENT_RECEIVED",
    payment: {
      id: paymentId,
      subscription: providerSubId,
      customer: "cus_s7_dev_validate",
      status: "RECEIVED",
      value: 19.9,
      dueDate: "2026-06-13",
      confirmedDate: "2026-05-13",
    },
  };

  const first = await runWebhook(paymentPayload);
  if (first.out.status !== 200 || !first.out.body?.processed) {
    fail("webhook PAYMENT_RECEIVED", JSON.stringify(first.out.body));
  } else {
    pass("webhook PAYMENT_RECEIVED processado");
  }

  const { data: eventRow } = await supabase
    .from("billing_events")
    .select("id, processing_status, processing_error")
    .eq("provider", "asaas")
    .eq("provider_event_id", eventId)
    .maybeSingle();
  if (!eventRow?.id) {
    fail("billing_events gravou evento", "linha não encontrada");
  } else {
    pass(`billing_events gravou evento (${eventRow.processing_status})`);
  }

  const dup = await runWebhook(paymentPayload);
  if (dup.out.status === 200 && dup.out.body?.duplicate === true) {
    pass("reenvio do mesmo evento retorna duplicate: true");
  } else {
    fail("idempotência duplicate", JSON.stringify(dup.out.body));
  }

  const { data: subAfterPay } = await supabase
    .from("billing_subscriptions")
    .select("status, current_period_end, next_due_date")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (subAfterPay?.status === "active") {
    pass("PAYMENT_RECEIVED ativa assinatura");
  } else {
    fail("PAYMENT_RECEIVED ativa assinatura", `status=${subAfterPay?.status}`);
  }

  const overdueId = `evt_s7_dev_${randomUUID()}`;
  const overduePayId = `pay_s7_dev_${randomUUID()}`;
  const overdue = await runWebhook({
    id: overdueId,
    event: "PAYMENT_OVERDUE",
    payment: {
      id: overduePayId,
      subscription: providerSubId,
      customer: "cus_s7_dev_validate",
      status: "OVERDUE",
      value: 19.9,
      dueDate: "2026-05-01",
    },
  });
  if (overdue.out.status === 200) {
    const { data: subOverdue } = await supabase.from("billing_subscriptions").select("status").eq("id", subscriptionId).maybeSingle();
    if (subOverdue?.status === "past_due") pass("PAYMENT_OVERDUE -> past_due");
    else fail("PAYMENT_OVERDUE -> past_due", `status=${subOverdue?.status}`);
  } else {
    fail("webhook PAYMENT_OVERDUE", JSON.stringify(overdue.out.body));
  }

  const cancelId = `evt_s7_dev_${randomUUID()}`;
  const cancel = await runWebhook({
    id: cancelId,
    event: "SUBSCRIPTION_DELETED",
    subscription: {
      id: providerSubId,
      customer: "cus_s7_dev_validate",
      status: "INACTIVE",
      nextDueDate: "2026-06-13",
    },
  });
  if (cancel.out.status === 200) {
    const { data: subCanceled } = await supabase
      .from("billing_subscriptions")
      .select("status, canceled_at, current_period_end")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (subCanceled?.status === "canceled" && subCanceled?.canceled_at) {
      pass("SUBSCRIPTION_DELETED -> canceled + canceled_at");
    } else {
      fail("SUBSCRIPTION_DELETED", JSON.stringify(subCanceled));
    }

    const futureEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("billing_subscriptions")
      .update({ current_period_end: futureEnd, status: "canceled", canceled_at: new Date().toISOString() })
      .eq("id", subscriptionId);

    const access = await canUserAccessPlanFeatures(supabase, fixture.userId);
    if (access.can_access === true) {
      pass("cancelamento com current_period_end futuro mantém can_access: true");
    } else {
      fail("grace period can_access", JSON.stringify(access));
    }
  } else {
    fail("webhook SUBSCRIPTION_DELETED", JSON.stringify(cancel.out.body));
  }

  const unauthorizedReq = makeReq(paymentPayload, "token-invalido");
  const unauthorizedRes = makeRes();
  const unauthorized = await handleAsaasWebhookRequest(supabase, unauthorizedReq, webhookToken);
  if (unauthorized.status === 401) {
    pass("webhook sem token válido retorna 401");
  } else {
    fail("webhook unauthorized", `status=${unauthorized.status}`);
  }

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erro fatal na validação:", e);
  process.exit(1);
});
