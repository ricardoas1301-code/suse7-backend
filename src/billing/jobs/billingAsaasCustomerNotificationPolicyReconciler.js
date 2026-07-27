// ======================================================================
// Reconciliador idempotente — notificationDisabled=true em customers Asaas
// S1.HF.ASAAS-NOTIFICATIONS.1
// Dry-run por padrão. Não cria cobrança/assinatura/Pix/boleto.
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  assertAsaasSandboxMutationsAllowed,
  assertBillingCustomerOwnership,
  ensureAsaasCustomerNotificationPolicy,
  listRemoteCustomerNotifications,
  maskAsaasCustomerId,
  summarizeCustomerNotificationChannels,
} from "../services/billingAsaasCustomerNotificationPolicyService.js";
import { POLICY_STATUS } from "../providers/customerCommunicationPolicyConstants.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {{
 *   dryRun?: boolean;
 *   limit?: number;
 *   concurrency?: number;
 *   checkpointAfter?: number;
 *   userIds?: string[];
 *   correlationId?: string;
 *   sleepMs?: (ms: number) => Promise<void>;
 * }} [options]
 */
export async function reconcileAsaasCustomerNotificationPolicies(supabase, providerApi, options = {}) {
  const dryRun = options.dryRun !== false;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 100;
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.min(5, Math.max(1, Number(options.concurrency)))
    : 2;
  const correlationId = options.correlationId || `recon-${Date.now()}`;
  const sleep =
    options.sleepMs ||
    ((ms) => new Promise((r) => setTimeout(r, ms)));

  const envGate = assertAsaasSandboxMutationsAllowed();
  if (!envGate.ok && !dryRun) {
    return {
      ok: false,
      blocked: true,
      code: envGate.error?.code,
      reasons: envGate.error?.reasons ?? [],
      dryRun,
    };
  }

  let query = supabase
    .from("billing_customers")
    .select("id, user_id, provider, provider_customer_id, email, created_at")
    .eq("provider", "asaas")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (Array.isArray(options.userIds) && options.userIds.length > 0) {
    query = query.in("user_id", options.userIds);
  }

  const { data: rows, error } = await query;
  if (error) throw error;

  const summary = {
    ok: true,
    dryRun,
    correlationId,
    found: rows?.length ?? 0,
    alreadyCorrect: 0,
    corrigiveis: 0,
    corrigidos: 0,
    semCustomerId: 0,
    idsInvalidos: 0,
    ownershipDivergente: 0,
    naoEncontrados: 0,
    errosTemporarios: 0,
    errosDefinitivos: 0,
    manualReview: 0,
    chargeEndpointsCalled: 0,
    results: /** @type {Array<Record<string, unknown>>} */ ([]),
  };

  const items = Array.isArray(rows) ? rows : [];
  let idx = 0;

  async function processOne(row) {
    const customerId = String(row.provider_customer_id || "").trim();
    const userId = String(row.user_id || "").trim();
    if (!customerId) {
      summary.semCustomerId += 1;
      summary.results.push({
        seller_id: userId,
        customer_id_masked: null,
        status: POLICY_STATUS.PERMANENT_ERROR,
        reason: "CUSTOMER_ID_ABSENT",
      });
      return;
    }
    if (!/^cus_[a-zA-Z0-9]+$/i.test(customerId) && customerId.length < 6) {
      summary.idsInvalidos += 1;
      summary.results.push({
        seller_id: userId,
        customer_id_masked: maskAsaasCustomerId(customerId),
        status: POLICY_STATUS.PERMANENT_ERROR,
        reason: "CUSTOMER_ID_INVALID",
      });
      return;
    }

    const ownership = await assertBillingCustomerOwnership(supabase, {
      userId,
      providerCustomerId: customerId,
      provider: "asaas",
    });
    if (!ownership.ok) {
      summary.ownershipDivergente += 1;
      summary.manualReview += 1;
      summary.results.push({
        seller_id: userId,
        customer_id_masked: maskAsaasCustomerId(customerId),
        status: POLICY_STATUS.MANUAL_REVIEW,
        reason: ownership.code,
      });
      return;
    }

    const result = await ensureAsaasCustomerNotificationPolicy(providerApi, {
      providerCustomerId: customerId,
      userId,
      dryRun,
      correlationId,
      skipCache: true,
    });

    if (result.ok && result.status === POLICY_STATUS.CONFIRMED_DISABLED && result.before?.notificationDisabled === true) {
      summary.alreadyCorrect += 1;
    } else if (result.ok && result.dryRun && result.status !== POLICY_STATUS.CONFIRMED_DISABLED) {
      summary.corrigiveis += 1;
    } else if (result.ok && result.status === POLICY_STATUS.CONFIRMED_DISABLED && !result.dryRun) {
      if (result.before?.notificationDisabled === true) summary.alreadyCorrect += 1;
      else summary.corrigidos += 1;
    } else if (result.status === POLICY_STATUS.RETRYABLE_ERROR) {
      summary.errosTemporarios += 1;
    } else if (result.status === POLICY_STATUS.MANUAL_REVIEW) {
      summary.manualReview += 1;
    } else if (!result.ok && String(result.reason || "").includes("404")) {
      summary.naoEncontrados += 1;
    } else if (!result.ok) {
      summary.errosDefinitivos += 1;
    }

    let channelSummary = null;
    if (typeof providerApi.listCustomerNotifications === "function" && !dryRun) {
      try {
        const listed = await listRemoteCustomerNotifications(providerApi, customerId);
        if (listed.ok) channelSummary = summarizeCustomerNotificationChannels(listed.notifications);
      } catch {
        /* auditoria opcional */
      }
    }

    summary.results.push({
      seller_id: userId,
      customer_id_masked: maskAsaasCustomerId(customerId),
      status: result.status,
      dryRun: Boolean(result.dryRun),
      before: result.before ?? null,
      after: result.after ?? null,
      channels: channelSummary,
    });

    // Rate limit leve
    await sleep(50 + Math.floor(Math.random() * 50));
  }

  async function worker() {
    while (idx < items.length) {
      const current = items[idx++];
      await processOne(current);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  logBilling("asaas", "ASAAS_NOTIFICATION_POLICY_RECONCILED", {
    correlation_id: correlationId,
    dry_run: dryRun,
    found: summary.found,
    already_correct: summary.alreadyCorrect,
    corrigidos: summary.corrigidos,
    corrigiveis: summary.corrigiveis,
  });

  return summary;
}
