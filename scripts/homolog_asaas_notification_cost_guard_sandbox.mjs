#!/usr/bin/env node
/**
 * Homologação controlada Sandbox — S1.HF.ASAAS-NOTIFICATIONS.1
 *
 * Requer:
 *   S7_APP_ENV=development
 *   ASAAS_ENV=sandbox
 *   ASAAS_API_KEY=(sandbox)
 *   HOMOLOG_ASAAS_CUSTOMER_ID=cus_...
 *   HOMOLOG_ASAAS_CUSTOMER_ALLOW=1
 *
 * Opcional (ownership):
 *   HOMOLOG_SELLER_USER_ID=uuid
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *
 * NÃO cria cobrança / assinatura / Pix / boleto / comunicação.
 */
import { createClient } from "@supabase/supabase-js";
import { getBillingProvider } from "../src/billing/providers/index.js";
import {
  assertAsaasSandboxMutationsAllowed,
  assertBillingCustomerOwnership,
  ensureAsaasCustomerNotificationPolicy,
  listRemoteCustomerNotifications,
  maskAsaasCustomerId,
  summarizeCustomerNotificationChannels,
} from "../src/billing/services/billingAsaasCustomerNotificationPolicyService.js";
import { resolveS7RuntimeEnvironment } from "../src/billing/services/billingRuntimeEnvironmentService.js";

const allow = String(process.env.HOMOLOG_ASAAS_CUSTOMER_ALLOW || "") === "1";
const customerId = String(process.env.HOMOLOG_ASAAS_CUSTOMER_ID || "").trim();
const sellerId = String(process.env.HOMOLOG_SELLER_USER_ID || "").trim();
const dryOnly = String(process.env.HOMOLOG_DRY_ONLY || "") === "1";

const runtime = resolveS7RuntimeEnvironment();
const envGate = assertAsaasSandboxMutationsAllowed();

const evidence = {
  mission: "S1.HF.ASAAS-NOTIFICATIONS.1",
  timestamp: new Date().toISOString(),
  correlation_id: `homolog-notif-${Date.now()}`,
  s7_app_env: runtime.s7AppEnv,
  asaas_env: runtime.asaasEnv,
  supabase_project_ref: runtime.supabaseProjectRef,
  hostname_base: process.env.ASAAS_API_BASE_URL || "(derived)",
  environment_ok: Boolean(envGate.ok),
  customer_id_masked: maskAsaasCustomerId(customerId),
  update_executed: false,
  charge_created: false,
  subscription_created: false,
  pix_generated: false,
  boleto_generated: false,
  card_charged: false,
  communication_sent: false,
  resend_called: false,
  webhook_removed: false,
  fiscal_changed: false,
};

function abort(reason) {
  console.error(JSON.stringify({ ...evidence, aborted: true, reason }, null, 2));
  process.exit(2);
}

if (!allow) abort("HOMOLOG_ASAAS_CUSTOMER_ALLOW!=1");
if (!customerId) abort("HOMOLOG_ASAAS_CUSTOMER_ID ausente");
if (!envGate.ok) abort("ambiente não confirmado como DEV+sandbox");
if (runtime.asaasEnv !== "sandbox") abort("ASAAS_ENV!=sandbox");

const providerApi = getBillingProvider("asaas");
providerApi.assertConfigured();

if (sellerId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const ownership = await assertBillingCustomerOwnership(supabase, {
    userId: sellerId,
    providerCustomerId: customerId,
  });
  evidence.ownership_ok = ownership.ok;
  evidence.ownership_code = ownership.code ?? null;
  if (!ownership.ok) abort(`ownership: ${ownership.code}`);
} else {
  evidence.ownership_ok = null;
  evidence.ownership_note = "ownership não validado via billing_customers (seller id/supabase ausentes)";
}

const before = await providerApi.getCustomer(customerId);
evidence.before = {
  notificationDisabled: before?.notificationDisabled ?? null,
  // sem PII
};

let notifBefore = { total: 0 };
try {
  const listed = await listRemoteCustomerNotifications(providerApi, customerId);
  if (listed.ok) {
    notifBefore = summarizeCustomerNotificationChannels(listed.notifications);
  }
} catch {
  notifBefore = { total: -1, error: "list_failed" };
}
evidence.notifications_before = notifBefore;

if (dryOnly) {
  evidence.dry_only = true;
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(0);
}

const result = await ensureAsaasCustomerNotificationPolicy(providerApi, {
  providerCustomerId: customerId,
  userId: sellerId || null,
  correlationId: evidence.correlation_id,
  skipCache: true,
});

evidence.update_executed = true;
evidence.ensure_ok = result.ok;
evidence.ensure_status = result.status;
evidence.after_ensure = result.after ?? null;

const after = await providerApi.getCustomer(customerId);
evidence.after = {
  notificationDisabled: after?.notificationDisabled ?? null,
};

let notifAfter = notifBefore;
try {
  const listed = await listRemoteCustomerNotifications(providerApi, customerId);
  if (listed.ok) notifAfter = summarizeCustomerNotificationChannels(listed.notifications);
} catch {
  /* ignore */
}
evidence.notifications_after = notifAfter;

evidence.notificationDisabled_confirmed = after?.notificationDisabled === true;
evidence.individual_channel_update_applied = false;
evidence.note =
  "notificationDisabled=true é a proteção aplicada; notificações individuais não foram alteradas em lote nesta homologação.";

console.log(JSON.stringify(evidence, null, 2));

if (!evidence.notificationDisabled_confirmed) process.exit(1);
