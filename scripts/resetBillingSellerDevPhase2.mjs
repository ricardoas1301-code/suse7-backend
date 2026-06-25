#!/usr/bin/env node
/**
 * Reset controlado de billing — DEV Fase 2 (um seller)
 *
 * 1) Diagnóstico (subscriptions, payments, renewal_cycles, payment_methods)
 * 2) Cancela cobranças/assinaturas no Asaas Sandbox
 * 3) Limpa estado local (soft cancel + delete renewal_cycles)
 * 4) Provisiona Baby/internal
 *
 * Uso:
 *   node scripts/resetBillingSellerDevPhase2.mjs --user-id=c8a62ec6-cfbe-4ad9-98ea-49fadebeda50
 *   node scripts/resetBillingSellerDevPhase2.mjs --email=lojarrfmoveis@gmail.com --confirm
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { SUBSCRIPTION_STATUS } from "../src/billing/billingConstants.js";

const DEFAULT_USER_ID = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const RESET_REASON = "dev_reset_phase2_controlled";

const PENDING_PAYMENT_STATUSES = new Set(["pending", "pendente", "awaiting_payment", "overdue", "vencido", "past_due"]);
const OPEN_SUB_STATUSES = new Set(["active", "pending", "past_due", "internal_free"]);

function parseArgs(argv) {
  let userId = DEFAULT_USER_ID;
  let email = null;
  let confirm = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--confirm") confirm = true;
    else if (arg.startsWith("--user-id=")) userId = arg.slice("--user-id=".length).trim();
    else if (arg.startsWith("--email=")) email = arg.slice("--email=".length).trim();
  }
  return { userId, email, confirm };
}

function assertSandboxOnly() {
  const base = String(process.env.ASAAS_API_BASE_URL || process.env.ASAAS_BASE_URL || "").toLowerCase();
  const allow = String(process.env.SUSE7_ALLOW_BILLING_SANDBOX_CLEANUP || "").trim() === "1";
  if (!allow && !base.includes("sandbox")) {
    throw new Error("ASAAS_API_BASE_URL deve ser sandbox ou SUSE7_ALLOW_BILLING_SANDBOX_CLEANUP=1");
  }
}

async function loadBillingModules() {
  const [{ getBillingProvider }, { AsaasApiError }, { ensureInternalBabySubscription }] = await Promise.all([
    import("../src/billing/providers/index.js"),
    import("../src/billing/providers/AsaasBillingProvider.js"),
    import("../src/billing/services/internalBabyPlanService.js"),
  ]);
  return { getBillingProvider, AsaasApiError, ensureInternalBabySubscription };
}

async function resolveUserId(supabase, { userId, email }) {
  if (!email) return userId;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = (data?.users ?? []).find((u) => String(u.email || "").toLowerCase() === email.toLowerCase());
    if (match?.id) return String(match.id);
    if ((data?.users ?? []).length < 200) break;
  }
  throw new Error(`Usuário não encontrado: ${email}`);
}

async function diagnose(supabase, userId) {
  const sections = [
    {
      title: "billing_subscriptions",
      query: supabase
        .from("billing_subscriptions")
        .select(
          "id, status, plan_key, plan_id, provider, provider_subscription_id, current_period_start, current_period_end, next_due_date, amount, created_at"
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
    },
    {
      title: "billing_payments (últimos 50)",
      query: supabase
        .from("billing_payments")
        .select(
          "id, status, provider, provider_payment_id, subscription_id, amount, paid_at, created_at, event_type_snapshot"
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(50),
    },
    {
      title: "billing_renewal_cycles",
      query: supabase
        .from("billing_renewal_cycles")
        .select(
          "id, subscription_id, current_plan_key, renewal_strategy, renewal_status, renewal_due_date, generated_payment_id, created_at"
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
    },
    {
      title: "billing_payment_methods",
      query: supabase
        .from("billing_payment_methods")
        .select("id, method_type, card_type, brand, last4, is_default, supports_auto_renew, status, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
    },
    {
      title: "billing_customers",
      query: supabase.from("billing_customers").select("id, provider, provider_customer_id, email, created_at").eq("user_id", userId),
    },
  ];

  console.log(`\n=== DIAGNÓSTICO BILLING — user_id=${userId} ===\n`);
  for (const section of sections) {
    const { data, error } = await section.query;
    if (error) {
      console.log(`[${section.title}] ERRO: ${error.message}`);
      continue;
    }
    console.log(`--- ${section.title} (${(data ?? []).length}) ---`);
    if ((data ?? []).length) console.table(data);
    else console.log("(vazio)\n");
  }
}

function isPendingPayment(row) {
  const s = String(row.status || "").toLowerCase();
  return PENDING_PAYMENT_STATUSES.has(s);
}

async function cancelPaymentOnAsaas(provider, providerPaymentId, AsaasApiError) {
  try {
    await provider.cancelPayment(providerPaymentId);
    return { ok: true };
  } catch (error) {
    if (error instanceof AsaasApiError && (error.status === 404 || error.status === 400)) {
      return { ok: true, skipped: true };
    }
    throw error;
  }
}

async function cancelSubscriptionOnAsaas(provider, providerSubscriptionId, AsaasApiError) {
  try {
    await provider.cancelSubscription(providerSubscriptionId);
    return { ok: true };
  } catch (error) {
    if (error instanceof AsaasApiError && (error.status === 404 || error.status === 400)) {
      return { ok: true, skipped: true };
    }
    throw error;
  }
}

async function executeReset(supabase, provider, userId, { AsaasApiError, ensureInternalBabySubscription }) {
  const now = new Date().toISOString();

  const { data: payments } = await supabase
    .from("billing_payments")
    .select("id, provider, provider_payment_id, status, raw_payload")
    .eq("user_id", userId)
    .eq("provider", "asaas");

  const { data: subscriptions } = await supabase
    .from("billing_subscriptions")
    .select("id, status, provider, provider_subscription_id, metadata, plan_key")
    .eq("user_id", userId);

  let asaasPaymentsCanceled = 0;
  let asaasSubsCanceled = 0;

  for (const row of payments ?? []) {
    if (!isPendingPayment(row)) continue;
    const payId = String(row.provider_payment_id || "").trim();
    if (!payId) continue;
    await cancelPaymentOnAsaas(provider, payId, AsaasApiError);
    asaasPaymentsCanceled += 1;
  }

  for (const sub of subscriptions ?? []) {
    if (String(sub.provider || "").toLowerCase() !== "asaas") continue;
    const subId = String(sub.provider_subscription_id || "").trim();
    if (!subId) continue;
    const status = String(sub.status || "").toLowerCase();
    if (status === SUBSCRIPTION_STATUS.CANCELED || status === SUBSCRIPTION_STATUS.REFUNDED) continue;
    await cancelSubscriptionOnAsaas(provider, subId, AsaasApiError);
    asaasSubsCanceled += 1;
  }

  const { error: delCyclesErr } = await supabase.from("billing_renewal_cycles").delete().eq("user_id", userId);
  if (delCyclesErr && !String(delCyclesErr.message).includes("does not exist")) throw delCyclesErr;

  for (const row of payments ?? []) {
    if (!isPendingPayment(row)) continue;
    const raw = row.raw_payload && typeof row.raw_payload === "object" ? { ...row.raw_payload } : {};
    await supabase
      .from("billing_payments")
      .update({
        status: "canceled",
        updated_at: now,
        raw_payload: { ...raw, dev_reset_phase2_at: now, dev_reset_phase2_reason: RESET_REASON },
      })
      .eq("id", row.id);
  }

  for (const sub of subscriptions ?? []) {
    const providerName = String(sub.provider || "").toLowerCase();
    const status = String(sub.status || "").toLowerCase();
    if (status === "cancelled" || status === SUBSCRIPTION_STATUS.CANCELED || status === SUBSCRIPTION_STATUS.REFUNDED) {
      continue;
    }

    const meta = sub.metadata && typeof sub.metadata === "object" ? { ...sub.metadata } : {};
    await supabase
      .from("billing_subscriptions")
      .update({
        status: SUBSCRIPTION_STATUS.CANCELED,
        canceled_at: now,
        updated_at: now,
        metadata: {
          ...meta,
          dev_reset_phase2_at: now,
          dev_reset_phase2_reason: RESET_REASON,
          delinquency_status: "none",
          auto_renew: false,
          overdue_since: null,
          grace_period_ends_at: null,
          access_suspended_at: null,
          plan_change_at_period_end: false,
          plan_change_target_plan_slug: null,
        },
      })
      .eq("id", sub.id);
  }

  try {
    await supabase
      .from("billing_payment_methods")
      .update({ status: "INACTIVE", is_default: false, updated_at: now })
      .eq("user_id", userId)
      .eq("status", "ACTIVE");
  } catch {
    /* tabela opcional em alguns ambientes */
  }

  const baby = await ensureInternalBabySubscription(supabase, userId);

  return { asaasPaymentsCanceled, asaasSubsCanceled, baby };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.confirm) {
    assertSandboxOnly();
  }

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { getBillingProvider, AsaasApiError, ensureInternalBabySubscription } = await loadBillingModules();
  const provider = getBillingProvider("asaas");
  const userId = await resolveUserId(supabase, args);
  const { data: userData } = await supabase.auth.admin.getUserById(userId);
  const userEmail = userData?.user?.email ?? userId;

  await diagnose(supabase, userId);

  if (!args.confirm) {
    console.log("\nDry-run. Nenhuma alteração feita.");
    console.log(`Para executar reset: node scripts/resetBillingSellerDevPhase2.mjs --user-id=${userId} --confirm\n`);
    console.log(`Ou por e-mail: --email=${userEmail} --confirm\n`);
    return;
  }

  console.log(`\n=== EXECUTANDO RESET (--confirm) — ${userEmail} ===\n`);
  const result = await executeReset(supabase, provider, userId, { AsaasApiError, ensureInternalBabySubscription });
  console.log("Resumo:", result);
  console.log("\nPós-reset: recarregue Minha assinatura no app (deve mostrar Baby/Free).");
  console.log("Próximo: assinar Starter pelo fluxo real → testar renewal engine.\n");

  await diagnose(supabase, userId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
