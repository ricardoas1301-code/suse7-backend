// ======================================================================
// Assinaturas Asaas órfãs — cancela checkouts de outros planos no gateway
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { listUserBillingSubscriptions } from "./billingSubscriptionQueryService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {Record<string, unknown>} row
 */
function isOrphanAsaasSubscriptionRow(row, activeSubscription) {
  const provider = String(row.provider || "").toLowerCase();
  if (provider !== "asaas") return false;

  const status = String(row.status || "").toLowerCase();
  if (status === SUBSCRIPTION_STATUS.CANCELED || status === SUBSCRIPTION_STATUS.REFUNDED) return false;

  if (!activeSubscription?.id) {
    return status === SUBSCRIPTION_STATUS.PENDING;
  }

  if (String(row.id) === String(activeSubscription.id)) return false;

  const activePlanId = activeSubscription.plan_id != null ? String(activeSubscription.plan_id) : null;
  const rowPlanId = row.plan_id != null ? String(row.plan_id) : null;

  if (status === SUBSCRIPTION_STATUS.PENDING) {
    if (activePlanId && rowPlanId && activePlanId === rowPlanId) return false;
    return true;
  }
  if (activePlanId && rowPlanId && activePlanId !== rowPlanId) return true;

  return false;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {Record<string, unknown>} row
 * @param {string} reason
 */
async function cancelOrphanRow(supabase, providerApi, row, reason) {
  const subAsaasId = asTrimmedString(row.provider_subscription_id);
  if (subAsaasId && typeof providerApi.cancelSubscription === "function") {
    try {
      await providerApi.cancelSubscription(subAsaasId);
    } catch (error) {
      logBillingError("billing", "orphan_asaas_subscription_cancel_failed", error, {
        subscription_id: row.id,
        provider_subscription_id: subAsaasId,
        reason,
      });
    }
  }

  const meta = row.metadata && typeof row.metadata === "object" ? /** @type {Record<string, unknown>} */ (row.metadata) : {};
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.CANCELED,
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        ...meta,
        orphan_canceled_at: new Date().toISOString(),
        orphan_cancel_reason: reason,
      },
    })
    .eq("id", row.id);
  if (error) throw error;

  logBilling("billing", "orphan_asaas_subscription_canceled", {
    subscription_id: row.id,
    plan_id: row.plan_id ?? null,
    plan_key: row.plan_key ?? null,
    provider_subscription_id: subAsaasId,
    reason,
  });
}

/**
 * Cancela assinaturas Asaas que não correspondem à assinatura ativa do seller.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} userId
 * @param {Record<string, unknown> | null} activeSubscription
 * @param {string} reason
 */
export async function cancelOrphanAsaasSubscriptionsForUser(supabase, providerApi, userId, activeSubscription, reason) {
  const list = await listUserBillingSubscriptions(supabase, userId, 50);
  let canceled = 0;

  for (const row of list) {
    if (!isOrphanAsaasSubscriptionRow(row, activeSubscription)) continue;
    await cancelOrphanRow(supabase, providerApi, row, reason);
    canceled += 1;
  }

  return { canceled };
}
