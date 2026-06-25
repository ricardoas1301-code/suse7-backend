#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { handleAsaasWebhookRequest } from "../src/billing/services/billingWebhookService.js";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "");
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const webhookToken = (process.env.ASAAS_WEBHOOK_TOKEN || "s7-billing-dev-validate-token").trim();
const providerSubId = "sub_s7_dev_vercel_validate";

if (!supabaseUrl || !serviceKey) {
  console.error("FAIL: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function makeReq(body) {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    url: "/api/billing/webhooks/asaas",
    headers: {
      host: "suse7-backend-dev.vercel.app",
      "asaas-access-token": webhookToken,
      "content-type": "application/json",
    },
    bodyBuffer: Buffer.from(raw, "utf8"),
  };
}

async function ensureFixture() {
  const { data: plan } = await supabase
    .from("plans")
    .select("id, plan_key")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const userId = usersData?.users?.[0]?.id;
  if (!plan?.id || !userId) throw new Error("fixture missing");
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
  if (existing?.id) await supabase.from("billing_subscriptions").update(row).eq("id", existing.id);
  else await supabase.from("billing_subscriptions").insert(row);
  return { userId: String(userId), planKey: String(plan.plan_key || "") };
}

async function resolveJwt() {
  const email = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
  const password = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";
  const { data: listed } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (!listed?.users?.some((u) => u.email === email)) {
    await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  }
  const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const authJson = await authRes.json();
  return typeof authJson?.access_token === "string" ? authJson.access_token : null;
}

async function main() {
  await ensureFixture();

  const confirmed = await handleAsaasWebhookRequest(
    supabase,
    makeReq({
      id: `evt_conf_${randomUUID()}`,
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: `pay_conf_${randomUUID()}`,
        subscription: providerSubId,
        customer: "cus_s7_dev_vercel_validate",
        status: "CONFIRMED",
        value: 19.9,
        dueDate: "2026-06-13",
        confirmedDate: "2026-05-13",
      },
    }),
    webhookToken
  );
  console.log(
    confirmed.status === 200 && confirmed.body?.processed === true
      ? "PASS: PAYMENT_CONFIRMED processado"
      : `FAIL: PAYMENT_CONFIRMED ${JSON.stringify(confirmed.body)}`
  );

  const inactivated = await handleAsaasWebhookRequest(
    supabase,
    makeReq({
      id: `evt_inact_${randomUUID()}`,
      event: "SUBSCRIPTION_INACTIVATED",
      subscription: {
        id: providerSubId,
        customer: "cus_s7_dev_vercel_validate",
        status: "INACTIVE",
        nextDueDate: "2026-06-13",
      },
    }),
    webhookToken
  );
  console.log(
    inactivated.status === 200 && inactivated.body?.processed === true
      ? "PASS: SUBSCRIPTION_INACTIVATED processado"
      : `FAIL: SUBSCRIPTION_INACTIVATED ${JSON.stringify(inactivated.body)}`
  );

  const jwt = await resolveJwt();
  if (!jwt) {
    console.log("FAIL: JWT DEV indisponível");
    process.exit(1);
  }
  const statusRes = await fetch(`${baseUrl}/api/billing/subscription/status`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const statusJson = await statusRes.json();
  console.log(statusRes.status === 200 && statusJson?.ok === true ? "PASS: subscription/status JWT 200" : `FAIL: subscription/status ${statusRes.status}`);
  console.log(statusJson?.access?.can_access != null ? `INFO: can_access=${statusJson.access.can_access}` : "FAIL: can_access ausente");
  console.log(statusJson?.subscriptions?.[0]?.plan_key ? "PASS: plan_key presente" : "FAIL: plan_key ausente");
  console.log(statusJson?.subscriptions?.[0]?.provider === "asaas" ? "PASS: provider asaas" : "FAIL: provider incorreto");
}

main().catch((e) => {
  console.error("Erro fatal:", e?.message || e);
  process.exit(1);
});
