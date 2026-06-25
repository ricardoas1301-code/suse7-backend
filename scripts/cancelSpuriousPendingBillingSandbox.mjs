#!/usr/bin/env node
/**
 * Limpeza segura — cobranças pendentes indevidas (SANDBOX / DEV apenas)
 *
 * Fluxo:
 * 1) Lista cobranças pendentes do usuário de teste (somente leitura no DB)
 * 2) Com --confirm: cancela no Asaas (DELETE /payments/{id}) e atualiza billing_payments local
 *
 * Uso:
 *   node scripts/cancelSpuriousPendingBillingSandbox.mjs --email=teste@exemplo.com
 *   node scripts/cancelSpuriousPendingBillingSandbox.mjs --user-id=<uuid>
 *   node scripts/cancelSpuriousPendingBillingSandbox.mjs --email=teste@exemplo.com --confirm
 *   node scripts/cancelSpuriousPendingBillingSandbox.mjs --email=teste@exemplo.com --confirm --include-subscriptions
 *
 * Variáveis: .env.local com SUPABASE_*, ASAAS_API_BASE_URL (sandbox), ASAAS_API_KEY
 * Guard: ASAAS_API_BASE_URL deve conter "sandbox" OU SUSE7_ALLOW_BILLING_SANDBOX_CLEANUP=1
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { getBillingProvider } from "../src/billing/providers/index.js";
import { AsaasApiError } from "../src/billing/providers/AsaasBillingProvider.js";

loadEnv({ path: ".env.local" });
loadEnv();

const CLEANUP_REASON = "spurious_auto_checkout_pre_fix";

const PENDING_PAYMENT_STATUSES = new Set(["pending", "pendente", "awaiting_payment", "overdue", "vencido", "past_due"]);
const PAID_PAYMENT_STATUSES = new Set(["paid", "pago", "received", "confirmed", "received_in_cash"]);
const PAID_ASAAS_STATUSES = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);

function parseArgs(argv) {
  let email = null;
  let userId = null;
  let confirm = false;
  let includeSubscriptions = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--confirm") confirm = true;
    else if (arg === "--include-subscriptions") includeSubscriptions = true;
    else if (arg.startsWith("--email=")) email = arg.slice("--email=".length).trim();
    else if (arg.startsWith("--user-id=")) userId = arg.slice("--user-id=".length).trim();
  }
  return { email, userId, confirm, includeSubscriptions };
}

function assertSandboxOnly() {
  const base = String(process.env.ASAAS_API_BASE_URL || "").toLowerCase();
  const allow = String(process.env.SUSE7_ALLOW_BILLING_SANDBOX_CLEANUP || "").trim() === "1";
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  const isProd = nodeEnv === "production" || vercelEnv === "production";

  if (isProd && !allow) {
    throw new Error("Bloqueado em produção. Use sandbox ou defina SUSE7_ALLOW_BILLING_SANDBOX_CLEANUP=1 com cautela.");
  }
  if (!allow && !base.includes("sandbox")) {
    throw new Error(
      "ASAAS_API_BASE_URL não parece sandbox. Use api-sandbox.asaas.com ou SUSE7_ALLOW_BILLING_SANDBOX_CLEANUP=1."
    );
  }
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isPendingPaymentRow(row) {
  const s = normalizeStatus(row.status);
  if (PAID_PAYMENT_STATUSES.has(s)) return false;
  return PENDING_PAYMENT_STATUSES.has(s);
}

function pickDueDate(row) {
  const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
  return raw.dueDate || raw.originalDueDate || row.subscription?.next_due_date || null;
}

function pickPaymentMethod(row) {
  const subMeta =
    row.subscription?.metadata && typeof row.subscription.metadata === "object" ? row.subscription.metadata : {};
  const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
  return subMeta.payment_method || raw.billingType || raw.paymentMethod || null;
}

async function resolveUserId(supabase, { email, userId }) {
  if (userId) return userId;
  const targetEmail = (email || process.env.DEV_BILLING_TEST_EMAIL || "").trim();
  if (!targetEmail) throw new Error("Informe --email=, --user-id= ou DEV_BILLING_TEST_EMAIL no .env.local");
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users ?? [];
    const match = users.find((u) => String(u.email || "").toLowerCase() === targetEmail.toLowerCase());
    if (match?.id) return String(match.id);
    if (users.length < 200) break;
  }
  throw new Error(`Usuário não encontrado para email: ${targetEmail}`);
}

async function listPendingPayments(supabase, userId) {
  const { data, error } = await supabase
    .from("billing_payments")
    .select(
      "id, user_id, subscription_id, provider, provider_payment_id, status, amount, currency, created_at, updated_at, event_type_snapshot, raw_payload, subscription:billing_subscriptions(id, plan_key, provider_subscription_id, status, next_due_date, metadata, plan_id)"
    )
    .eq("user_id", userId)
    .eq("provider", "asaas")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).filter(isPendingPaymentRow);
}

async function listPendingSubscriptions(supabase, userId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, plan_key, provider_subscription_id, status, amount, next_due_date, created_at, updated_at, metadata")
    .eq("user_id", userId)
    .eq("provider", "asaas")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

function printPaymentTable(rows, userEmail) {
  console.log(`\n=== Cobranças pendentes (user: ${userEmail}) — ${rows.length} linha(s) ===\n`);
  if (rows.length === 0) {
    console.log("(nenhuma)");
    return;
  }
  const table = rows.map((row) => ({
    payment_internal_id: row.id,
    asaas_payment_id: row.provider_payment_id,
    asaas_subscription_id: row.subscription?.provider_subscription_id ?? null,
    plan_key: row.subscription?.plan_key ?? null,
    payment_method: pickPaymentMethod(row),
    amount: row.amount,
    status: row.status,
    due_date: pickDueDate(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  console.table(table);
}

async function markPaymentCanceledLocal(supabase, row, extra = {}) {
  const previousStatus = row.status;
  const raw =
    row.raw_payload && typeof row.raw_payload === "object" ? { ...row.raw_payload } : {};
  const patch = {
    status: "CANCELED",
    updated_at: new Date().toISOString(),
    raw_payload: {
      ...raw,
      sandbox_cleanup_at: new Date().toISOString(),
      sandbox_cleanup_reason: CLEANUP_REASON,
      sandbox_cleanup_by: "cancelSpuriousPendingBillingSandbox.mjs",
      sandbox_cleanup_previous_status: previousStatus,
      ...extra,
    },
  };
  const { error } = await supabase.from("billing_payments").update(patch).eq("id", row.id);
  if (error) throw error;
}

async function markSubscriptionCanceledLocal(supabase, row) {
  const meta = row.metadata && typeof row.metadata === "object" ? { ...row.metadata } : {};
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: "canceled",
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        ...meta,
        sandbox_cleanup_at: new Date().toISOString(),
        sandbox_cleanup_reason: CLEANUP_REASON,
        sandbox_cleanup_by: "cancelSpuriousPendingBillingSandbox.mjs",
      },
    })
    .eq("id", row.id);
  if (error) throw error;
}

async function cancelPaymentOnAsaas(provider, providerPaymentId) {
  try {
    await provider.cancelPayment(providerPaymentId);
    return { ok: true, skipped: false };
  } catch (error) {
    if (error instanceof AsaasApiError && (error.status === 404 || error.status === 400)) {
      return { ok: true, skipped: true, reason: `asaas_http_${error.status}` };
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  assertSandboxOnly();

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error("Falta SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em .env.local");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const provider = getBillingProvider("asaas");

  const userId = await resolveUserId(supabase, args);
  const { data: userData } = await supabase.auth.admin.getUserById(userId);
  const userEmail = userData?.user?.email ?? userId;

  const pendingPayments = await listPendingPayments(supabase, userId);
  printPaymentTable(pendingPayments, userEmail);

  if (args.includeSubscriptions) {
    const pendingSubs = await listPendingSubscriptions(supabase, userId);
    console.log(`\n=== Assinaturas Asaas pending — ${pendingSubs.length} linha(s) ===\n`);
    if (pendingSubs.length) console.table(pendingSubs);
  }

  if (!args.confirm) {
    console.log("\nModo diagnóstico (dry-run). Nenhuma alteração feita.");
    console.log("Para cancelar no Asaas + atualizar DB local: adicione --confirm\n");
    return;
  }

  console.log("\n=== EXECUTANDO CANCELAMENTO (--confirm) ===\n");

  let canceledPayments = 0;
  let skippedPaid = 0;
  let skippedAsaas = 0;

  for (const row of pendingPayments) {
    const payId = String(row.provider_payment_id || "").trim();
    if (!payId) {
      console.warn(`SKIP payment ${row.id}: sem provider_payment_id`);
      continue;
    }

    let remoteStatus = null;
    try {
      const remote = await provider.getPayment(payId);
      remoteStatus = String(remote?.status || "").toUpperCase();
      if (PAID_ASAAS_STATUSES.has(remoteStatus)) {
        console.warn(`SKIP ${payId}: já pago no Asaas (${remoteStatus})`);
        skippedPaid += 1;
        continue;
      }
    } catch (error) {
      console.warn(`WARN ${payId}: não foi possível ler no Asaas — ${error instanceof Error ? error.message : error}`);
    }

    const asaasResult = await cancelPaymentOnAsaas(provider, payId);
    if (asaasResult.skipped) {
      skippedAsaas += 1;
    }

    await markPaymentCanceledLocal(supabase, row, {
      sandbox_cleanup_asaas_status: remoteStatus,
      sandbox_cleanup_asaas_result: asaasResult.skipped ? asaasResult.reason : "deleted",
    });
    canceledPayments += 1;
    console.log(`OK payment ${row.id} / ${payId}`);
  }

  if (args.includeSubscriptions) {
    const pendingSubs = await listPendingSubscriptions(supabase, userId);
    for (const sub of pendingSubs) {
      const subAsaasId = String(sub.provider_subscription_id || "").trim();
      if (!subAsaasId) continue;
      try {
        await provider.cancelSubscription(subAsaasId);
      } catch (error) {
        console.warn(`WARN subscription ${sub.id}: ${error instanceof Error ? error.message : error}`);
      }
      await markSubscriptionCanceledLocal(supabase, sub);
      console.log(`OK subscription ${sub.id} / ${subAsaasId}`);
    }
  }

  console.log("\n=== RESUMO ===");
  console.log({ canceledPayments, skippedPaid, skippedAsaas, userEmail });
  console.log("\nValide no painel Asaas Sandbox e no Histórico Suse7.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
