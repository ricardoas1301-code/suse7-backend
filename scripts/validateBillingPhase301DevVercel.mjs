#!/usr/bin/env node
/**
 * Fase 3.0.1 — validação em DEV (Vercel + Supabase + Asaas Sandbox opcional).
 * Uso: node scripts/validateBillingPhase301DevVercel.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "");
const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN?.trim() || "";
const asaasBase = (process.env.ASAAS_API_BASE_URL || process.env.ASAAS_BASE_URL || "").replace(/\/+$/, "");
const asaasKey = process.env.ASAAS_API_KEY?.trim() || "";
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim() || "";
const providerSubId = "sub_s7_phase301_dev_validate";
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
 * @param {RequestInit} [init]
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
 */
async function postWebhook(payload) {
  return api("/api/billing/webhooks/asaas", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "asaas-access-token": webhookToken,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * @param {string} eventType
 * @param {string} providerEventId
 * @param {string} paymentId
 * @param {Record<string, unknown>} [extra]
 */
function paymentBody(eventType, providerEventId, paymentId, extra = {}) {
  return {
    id: providerEventId,
    event: eventType,
    payment: {
      id: paymentId,
      subscription: providerSubId,
      customer: "cus_s7_phase301_dev_validate",
      status: extra.status ?? "CONFIRMED",
      value: 49.9,
      dueDate: "2026-06-18",
      confirmedDate: new Date().toISOString().slice(0, 10),
      billingType: "PIX",
      description: "Suse7 — Fase 3.0.1 DEV",
      ...extra,
    },
  };
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

  await supabase.from("billing_customers").upsert(
    {
      user_id: userId,
      provider: "asaas",
      provider_customer_id: "cus_s7_phase301_dev_validate",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );

  const row = {
    user_id: userId,
    plan_id: plan.id,
    plan_key: plan.plan_key,
    provider: "asaas",
    provider_customer_id: "cus_s7_phase301_dev_validate",
    provider_subscription_id: providerSubId,
    status: "pending",
    amount: 49.9,
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

  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = usersData?.users?.find((u) => u.email === testEmail);
  if (!existing) {
    await supabase.auth.admin.createUser({ email: testEmail, password: testPassword, email_confirm: true });
  }

  const key = anonKey || serviceKey;
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const json = await res.json();
  return typeof json?.access_token === "string" ? json.access_token : null;
}

/**
 * @param {string} asaasPaymentId
 */
async function asaasSandboxConfirmPayment(asaasPaymentId) {
  if (!asaasBase || !asaasKey) return { ok: false, reason: "asaas_env_missing" };
  const url = `${asaasBase}/payments/${asaasPaymentId}/receiveInCash`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      access_token: asaasKey,
    },
    body: JSON.stringify({
      paymentDate: new Date().toISOString().slice(0, 10),
      value: 49.9,
      notifyCustomer: false,
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} correlationId
 */
async function countByCorrelation(supabase, table, userId, correlationId, extra = {}) {
  let q = supabase.from(table).select("id", { count: "exact", head: true }).eq("user_id", userId).eq("correlation_id", correlationId);
  for (const [k, v] of Object.entries(extra)) q = q.eq(k, v);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`=== S7 Fase 3.0.1 — DEV Vercel (${baseUrl}) ===`);

  if (!webhookToken) {
    fail("ASAAS_WEBHOOK_TOKEN", "ausente em .env.local");
    process.exit(1);
  }
  if (!supabaseUrl || !serviceKey) {
    fail("Supabase", "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const fixture = await ensureFixture(supabase);
  const jwt = await resolveJwt(supabase);
  if (!jwt) {
    fail("JWT teste", "não foi possível autenticar");
    process.exit(1);
  }

  const createdEventId = `evt_dev301_${randomUUID()}`;
  const createdPayId = `pay_dev301_${randomUUID()}`;

  const created = await postWebhook(
    paymentBody("PAYMENT_CREATED", createdEventId, createdPayId, { status: "PENDING" })
  );
  if (created.status === 200 && created.body?.processed) pass("1) PAYMENT_CREATED no Vercel DEV");
  else fail("1) PAYMENT_CREATED", JSON.stringify(created.body));

  let sandboxApproved = false;
  if (asaasBase.includes("sandbox") && asaasKey) {
    const asaasConfirm = await asaasSandboxConfirmPayment(createdPayId);
    if (asaasConfirm.ok) {
      sandboxApproved = true;
      pass("1) Asaas Sandbox receiveInCash (pagamento simulado)");
    } else {
      console.log(
        `INFO: Asaas receiveInCash skip (payment id sintético ou inexistente no sandbox): status=${asaasConfirm.status}`
      );
    }
  }

  const confEventId = `evt_dev301_${randomUUID()}`;
  const confPayId = createdPayId;
  const confirmed = await postWebhook(paymentBody("PAYMENT_CONFIRMED", confEventId, confPayId));
  if (confirmed.status === 200 && confirmed.body?.processed) {
    pass("1) PAYMENT_CONFIRMED processado no Vercel DEV (equivalente webhook pós-aprovação)");
  } else {
    fail("1) PAYMENT_CONFIRMED", JSON.stringify(confirmed.body));
  }

  if (sandboxApproved) {
    pass("1) fluxo sandbox Asaas tentado antes do webhook confirmado");
  }

  await sleep(1500);

  const timelineRes = await api("/api/billing/timeline?limit=30", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (timelineRes.status !== 200) {
    fail("2) GET /api/billing/timeline", `status=${timelineRes.status} body=${JSON.stringify(timelineRes.body)}`);
  } else {
    const events = Array.isArray(timelineRes.body?.timeline) ? timelineRes.body.timeline : [];
    const confirmedEvents = events.filter(
      (e) =>
        String(e?.event_type) === "PAYMENT_CONFIRMED" &&
        (String(e?.correlation_id) === confEventId ||
          String(e?.payload?.provider_payment_id) === confPayId ||
          String(e?.payload?.provider_event_id) === confEventId)
    );
    if (confirmedEvents.length >= 1) {
      pass(`2) GET /api/billing/timeline contém PAYMENT_CONFIRMED (${confirmedEvents.length})`);
    } else {
      fail("2) timeline PAYMENT_CONFIRMED", `eventos=${events.map((e) => e.event_type).slice(0, 8).join(",")}`);
    }
  }

  const auditCount = await countByCorrelation(supabase, "billing_audit_logs", fixture.userId, confEventId, {
    action: "payment_status_changed",
  });
  if (auditCount >= 1) pass(`3) audit log payment_status_changed (${auditCount})`);
  else fail("3) audit log", `count=${auditCount}`);

  const notifyCount = await countByCorrelation(supabase, "billing_notification_dispatches", fixture.userId, confEventId);
  if (notifyCount >= 1) pass(`4) notification dispatch (${notifyCount})`);
  else fail("4) notification dispatch", `count=${notifyCount}`);

  const timelineDbCount = await supabase
    .from("billing_timeline_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", fixture.userId)
    .eq("event_type", "PAYMENT_CONFIRMED")
    .eq("correlation_id", confEventId);
  const beforeDup = timelineDbCount.count ?? 0;

  const dup = await postWebhook(paymentBody("PAYMENT_CONFIRMED", confEventId, confPayId));
  if (dup.status === 200 && dup.body?.duplicate === true) pass("5) reenvio webhook → duplicate: true");
  else fail("5) reenvio webhook idempotente", JSON.stringify(dup.body));

  const timelineDbAfter = await supabase
    .from("billing_timeline_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", fixture.userId)
    .eq("event_type", "PAYMENT_CONFIRMED")
    .eq("correlation_id", confEventId);
  const afterDup = timelineDbAfter.count ?? 0;
  if (afterDup === beforeDup && beforeDup >= 1) pass(`5) timeline sem duplicata (${beforeDup} → ${afterDup})`);
  else fail("5) timeline duplicata", `${beforeDup} → ${afterDup}`);

  const statusRes = await api("/api/billing/subscription/status", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const activeSub = statusRes.body?.active_subscription ?? statusRes.body?.subscription;
  const revenueHealth = statusRes.body?.revenue_health;
  if (
    statusRes.status === 200 &&
    String(activeSub?.status || statusRes.body?.subscription_status || "").toLowerCase() === "active" &&
    String(revenueHealth?.health_level || "").toUpperCase() === "HEALTHY"
  ) {
    pass("extra) subscription/status active + revenue_health HEALTHY");
  } else {
    fail("extra) subscription/status", JSON.stringify({ activeSub, revenueHealth }));
  }

  const genNotify = await supabase
    .from("billing_notification_templates")
    .select("template_key")
    .eq("template_key", "payment.generated")
    .eq("is_active", true)
    .maybeSingle();
  if (genNotify.data?.template_key) pass("extra) template payment.generated ativo no DEV");
  else fail("extra) template payment.generated", "não encontrado — migration 20260521130000?");

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
