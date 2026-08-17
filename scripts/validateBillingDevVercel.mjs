#!/usr/bin/env node
/**
 * Validação BILLING 03.5 no host Vercel DEV (webhook + subscription/status).
 * Uso:
 *   ASAAS_WEBHOOK_TOKEN=... node scripts/validateBillingDevVercel.mjs
 * Opcional JWT: DEV_BILLING_TEST_JWT=... ou DEV_BILLING_TEST_EMAIL + DEV_BILLING_TEST_PASSWORD
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "");
const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN?.trim() || "";
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const providerSubId = "sub_s7_dev_vercel_validate";
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";

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
 * @param {string} path
 * @param {RequestInit} init
 */
async function api(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string | null} token
 */
async function postWebhook(payload, token) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (token) headers["asaas-access-token"] = token;
  return api("/api/billing/webhooks/asaas", { method: "POST", headers, body: JSON.stringify(payload) });
}

async function ensureFixture(supabase) {
  const { data: plan } = await supabase
    .from("plans")
    .select("id, plan_key")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!plan?.id) throw new Error("Nenhum plano ativo");

  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  let userId = usersData?.users?.find((u) => u.email === testEmail)?.id;
  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user.id;
  }
  if (!userId) throw new Error("Usuário de teste não encontrado");

  const row = {
    user_id: userId,
    plan_id: plan.id,
    plan_key: plan.plan_key,
    provider: "asaas",
    provider_customer_id: "cus_s7_dev_vercel_validate",
    provider_subscription_id: providerSubId,
    status: "pending",
    amount: 19.9,
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
    return { userId: String(userId), subscriptionId: String(existing.id), planKey: String(plan.plan_key || "") };
  }

  const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("id").single();
  if (error) throw error;
  return { userId: String(userId), subscriptionId: String(data.id), planKey: String(plan.plan_key || "") };
}

async function resolveJwt(supabase) {
  const direct = process.env.DEV_BILLING_TEST_JWT?.trim();
  if (direct) return direct;

  const email = testEmail;
  const password = testPassword;

  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = usersData?.users?.find((u) => u.email === email);
  if (!existing) {
    const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
  }

  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  return typeof json?.access_token === "string" ? json.access_token : null;
}

/**
 * @param {string} eventType
 * @param {string} providerEventId
 * @param {string} paymentId
 */
function paymentBody(eventType, providerEventId, paymentId) {
  return {
    id: providerEventId,
    event: eventType,
    payment: {
      id: paymentId,
      subscription: providerSubId,
      customer: "cus_s7_dev_vercel_validate",
      status: eventType.replace("PAYMENT_", ""),
      value: 19.9,
      dueDate: "2026-06-13",
      confirmedDate: "2026-05-13",
    },
  };
}

/**
 * @param {string} eventType
 * @param {string} providerEventId
 */
function subscriptionBody(eventType, providerEventId) {
  return {
    id: providerEventId,
    event: eventType,
    subscription: {
      id: providerSubId,
      customer: "cus_s7_dev_vercel_validate",
      status: eventType.includes("INACTIVATED") || eventType.includes("DELETED") ? "INACTIVE" : "ACTIVE",
      nextDueDate: "2026-06-13",
    },
  };
}

async function subscriptionStatus(supabase, subscriptionId) {
  const { data } = await supabase.from("billing_subscriptions").select("status").eq("id", subscriptionId).maybeSingle();
  return data?.status ? String(data.status) : null;
}

async function main() {
  console.log(`=== S7 BILLING 03.6 — Vercel DEV (${baseUrl}) ===`);

  const ping = await api("/api/billing/ping");
  if (ping.status === 200 && ping.body?.ok === true) pass("GET /api/billing/ping -> 200");
  else fail("GET /api/billing/ping", `status=${ping.status}`);

  const noToken = await postWebhook({ event: "PAYMENT_RECEIVED" }, null);
  if (noToken.status === 401) pass("webhook sem token -> 401");
  else fail("webhook sem token", `status=${noToken.status}`);

  const badToken = await postWebhook({ event: "PAYMENT_RECEIVED" }, "token-invalido-vercel");
  if (badToken.status === 401) pass("webhook token inválido -> 401");
  else fail("webhook token inválido", `status=${badToken.status}`);

  if (!webhookToken) {
    fail("ASAAS_WEBHOOK_TOKEN local", "defina no ambiente para testar token válido no host Vercel");
    console.log("\n--- resumo ---");
    for (const line of results) console.log(line);
    process.exit(1);
  }

  if (!supabaseUrl || !serviceKey) {
    fail("Supabase local", "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const fixture = await ensureFixture(supabase);

  const receivedEventId = `evt_vercel_${randomUUID()}`;
  const receivedPayId = `pay_vercel_${randomUUID()}`;
  const received = await postWebhook(paymentBody("PAYMENT_RECEIVED", receivedEventId, receivedPayId), webhookToken);
  if (received.status === 200 && received.body?.processed === true) pass("PAYMENT_RECEIVED processado no host Vercel");
  else fail("PAYMENT_RECEIVED", JSON.stringify(received));
  if ((await subscriptionStatus(supabase, fixture.subscriptionId)) === "active") pass("PAYMENT_RECEIVED -> active");
  else fail("PAYMENT_RECEIVED -> active", await subscriptionStatus(supabase, fixture.subscriptionId));

  const { data: eventRow } = await supabase
    .from("billing_events")
    .select("id, processing_status")
    .eq("provider", "asaas")
    .eq("provider_event_id", receivedEventId)
    .maybeSingle();
  if (eventRow?.id) pass("billing_events registrou PAYMENT_RECEIVED");
  else fail("billing_events PAYMENT_RECEIVED", "linha ausente");

  const { data: payRow } = await supabase
    .from("billing_payments")
    .select("id")
    .eq("provider", "asaas")
    .eq("provider_payment_id", receivedPayId)
    .maybeSingle();
  if (payRow?.id) pass("billing_payments registrou PAYMENT_RECEIVED");
  else fail("billing_payments PAYMENT_RECEIVED", "linha ausente");

  const dup = await postWebhook(paymentBody("PAYMENT_RECEIVED", receivedEventId, receivedPayId), webhookToken);
  if (dup.status === 200 && dup.body?.duplicate === true) pass("reenvio duplicate: true no host Vercel");
  else fail("duplicate no host Vercel", JSON.stringify(dup));

  const confirmed = await postWebhook(
    paymentBody("PAYMENT_CONFIRMED", `evt_vercel_${randomUUID()}`, `pay_vercel_${randomUUID()}`),
    webhookToken
  );
  if (confirmed.status === 200 && confirmed.body?.processed === true) pass("PAYMENT_CONFIRMED processado no host Vercel");
  else fail("PAYMENT_CONFIRMED", JSON.stringify(confirmed));
  if ((await subscriptionStatus(supabase, fixture.subscriptionId)) === "active") pass("PAYMENT_CONFIRMED -> active");
  else fail("PAYMENT_CONFIRMED -> active", await subscriptionStatus(supabase, fixture.subscriptionId));

  const overdue = await postWebhook(
    paymentBody("PAYMENT_OVERDUE", `evt_vercel_${randomUUID()}`, `pay_vercel_${randomUUID()}`),
    webhookToken
  );
  if (overdue.status === 200 && overdue.body?.processed === true) pass("PAYMENT_OVERDUE processado no host Vercel");
  else fail("PAYMENT_OVERDUE", JSON.stringify(overdue));
  if ((await subscriptionStatus(supabase, fixture.subscriptionId)) === "past_due") pass("PAYMENT_OVERDUE -> past_due");
  else fail("PAYMENT_OVERDUE -> past_due", await subscriptionStatus(supabase, fixture.subscriptionId));

  const deleted = await postWebhook(
    subscriptionBody("SUBSCRIPTION_DELETED", `evt_vercel_${randomUUID()}`),
    webhookToken
  );
  if (deleted.status === 200 && deleted.body?.processed === true) pass("SUBSCRIPTION_DELETED processado no host Vercel");
  else fail("SUBSCRIPTION_DELETED", JSON.stringify(deleted));
  if ((await subscriptionStatus(supabase, fixture.subscriptionId)) === "canceled") pass("SUBSCRIPTION_DELETED -> canceled");
  else fail("SUBSCRIPTION_DELETED -> canceled", await subscriptionStatus(supabase, fixture.subscriptionId));

  await ensureFixture(supabase);

  const inactivated = await postWebhook(
    subscriptionBody("SUBSCRIPTION_INACTIVATED", `evt_vercel_${randomUUID()}`),
    webhookToken
  );
  if (inactivated.status === 200 && inactivated.body?.processed === true) pass("SUBSCRIPTION_INACTIVATED processado no host Vercel");
  else fail("SUBSCRIPTION_INACTIVATED", JSON.stringify(inactivated));
  if ((await subscriptionStatus(supabase, fixture.subscriptionId)) === "canceled") pass("SUBSCRIPTION_INACTIVATED -> canceled");
  else fail("SUBSCRIPTION_INACTIVATED -> canceled", await subscriptionStatus(supabase, fixture.subscriptionId));

  const { data: subRow } = await supabase
    .from("billing_subscriptions")
    .select("status, plan_key, current_period_start, current_period_end, canceled_at")
    .eq("id", fixture.subscriptionId)
    .maybeSingle();

  if (subRow?.plan_key === fixture.planKey) pass("plan_key persistido na assinatura");
  else fail("plan_key persistido", JSON.stringify(subRow));

  const futureEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabase
    .from("billing_subscriptions")
    .update({ current_period_end: futureEnd, status: "canceled", canceled_at: new Date().toISOString() })
    .eq("id", fixture.subscriptionId);

  const jwt = await resolveJwt(supabase);
  if (!jwt) {
    fail("JWT DEV", "defina DEV_BILLING_TEST_JWT ou DEV_BILLING_TEST_EMAIL/PASSWORD + SUPABASE_ANON_KEY");
  } else {
    const status = await api("/api/billing/subscription/status", {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (status.status === 200 && status.body?.access) {
      pass("GET /api/billing/subscription/status com JWT -> 200");
      if (status.body.access.can_access === true) pass("can_access true com período futuro após cancelamento");
      else fail("can_access período futuro", JSON.stringify(status.body.access));
    } else {
      fail("subscription/status JWT", JSON.stringify(status));
    }
  }

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
