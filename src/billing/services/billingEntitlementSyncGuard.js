// ======================================================================
// Guarda de sync/webhook — HARD_PAUSED (S1.HF.6.7)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { resolveBillingSubscriptionEntitlementSnapshot } from "./billingSubscriptionEntitlementService.js";
import { recordHardPausedIgnoredWebhookEvent } from "./billingSyncPauseAuditService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ now?: Date }} [options]
 */
export async function resolveSellerSyncGate(supabase, userId, options = {}) {
  const entitlement = await resolveBillingSubscriptionEntitlementSnapshot(supabase, {
    userId,
    now: options.now,
  });
  return {
    sync_state: entitlement?.sync_state ?? "FULL",
    access_state: entitlement?.access_state ?? "LIBERATED",
    hard_paused: entitlement?.sync_state === "HARD_PAUSED" || entitlement?.access_state === "HARD_PAUSED",
    entitlement,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   now?: Date;
 * }} ctx
 */
export async function assertOperationalSyncAllowed(supabase, ctx) {
  const gate = await resolveSellerSyncGate(supabase, ctx.userId, { now: ctx.now });
  if (!gate.hard_paused) {
    return { allowed: true, gate };
  }
  return { allowed: false, gate, reason: "SYNC_HARD_PAUSED" };
}

/**
 * Webhook HARD_PAUSED — 2xx lógico, sem persistir entidade operacional.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   now?: Date;
 * }} ctx
 */
export async function handleHardPausedWebhookAck(supabase, ctx) {
  const gate = await resolveSellerSyncGate(supabase, ctx.userId, { now: ctx.now });
  if (!gate.hard_paused) return { hard_paused: false, acknowledged: false };

  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, ctx.userId);
  const subscriptionId = canonicalSubscription?.id != null ? String(canonicalSubscription.id) : null;
  const metadata =
    canonicalSubscription?.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};

  if (subscriptionId) {
    await recordHardPausedIgnoredWebhookEvent(supabase, {
      subscriptionId,
      metadata,
      marketplace: ctx.marketplace ?? "mercadolivre",
      marketplaceAccountId: ctx.marketplaceAccountId ?? null,
      now: ctx.now,
      reason: "BABY_LIMIT_REACHED",
    });
  }

  logBilling("billing", "BILLING_WEBHOOK_HARD_PAUSED_ACK", {
    user_id: ctx.userId,
    marketplace_account_id: ctx.marketplaceAccountId ?? null,
  });

  return { hard_paused: true, acknowledged: true, ok: true };
}

/**
 * Polling/jobs — interrompe sync ativa quando HARD_PAUSED.
 */
export async function shouldSkipActiveSyncForUser(supabase, userId, options = {}) {
  const gate = await resolveSellerSyncGate(supabase, userId, options);
  return gate.hard_paused;
}
