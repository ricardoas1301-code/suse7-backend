// ======================================================================
// Auditoria agregada do gap — HARD_PAUSED (sem payload sensível)
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_BACKFILL_STATUS,
  BILLING_SYNC_METADATA_KEYS,
} from "../billingConstants.js";
import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";
import { patchSubscriptionEntitlementMetadata } from "./billingSellerEntitlementStoreService.js";

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function readSyncPauseAuditFromMetadata(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return {
    sync_state: meta[BILLING_SYNC_METADATA_KEYS.SYNC_STATE] ?? null,
    pause_started_at: meta[BILLING_SYNC_METADATA_KEYS.PAUSE_STARTED_AT] ?? null,
    sync_resumed_at: meta[BILLING_SYNC_METADATA_KEYS.SYNC_RESUMED_AT] ?? null,
    data_gap_start: meta[BILLING_SYNC_METADATA_KEYS.DATA_GAP_START] ?? null,
    data_gap_end: meta[BILLING_SYNC_METADATA_KEYS.DATA_GAP_END] ?? null,
    ignored_event_count: Number(meta[BILLING_SYNC_METADATA_KEYS.IGNORED_EVENT_COUNT] ?? 0) || 0,
    backfill_status: meta[BILLING_SYNC_METADATA_KEYS.BACKFILL_STATUS] ?? BILLING_BACKFILL_STATUS.NOT_REQUESTED,
    last_data_updated_at: meta[BILLING_SYNC_METADATA_KEYS.LAST_DATA_UPDATED_AT] ?? null,
    first_ignored_event_at: meta[BILLING_SYNC_METADATA_KEYS.FIRST_IGNORED_EVENT_AT] ?? null,
    last_ignored_event_at: meta[BILLING_SYNC_METADATA_KEYS.LAST_IGNORED_EVENT_AT] ?? null,
    ignored_marketplace: meta[BILLING_SYNC_METADATA_KEYS.IGNORED_MARKETPLACE] ?? null,
    ignored_account_id: meta[BILLING_SYNC_METADATA_KEYS.IGNORED_ACCOUNT_ID] ?? null,
    ignored_reason: meta[BILLING_SYNC_METADATA_KEYS.IGNORED_REASON] ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   subscriptionId: string;
 *   metadata: Record<string, unknown>;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   now?: Date;
 *   reason?: string;
 * }} ctx
 */
export async function recordHardPausedIgnoredWebhookEvent(supabase, ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const audit = readSyncPauseAuditFromMetadata(ctx.metadata);
  const ignoredCount = audit.ignored_event_count + 1;

  const patch = {
    [BILLING_SYNC_METADATA_KEYS.IGNORED_EVENT_COUNT]: ignoredCount,
    [BILLING_SYNC_METADATA_KEYS.LAST_IGNORED_EVENT_AT]: now.toISOString(),
    [BILLING_SYNC_METADATA_KEYS.IGNORED_MARKETPLACE]: ctx.marketplace ?? audit.ignored_marketplace,
    [BILLING_SYNC_METADATA_KEYS.IGNORED_ACCOUNT_ID]: ctx.marketplaceAccountId ?? audit.ignored_account_id,
    [BILLING_SYNC_METADATA_KEYS.IGNORED_REASON]: ctx.reason ?? "BABY_LIMIT_REACHED",
    [BILLING_SYNC_METADATA_KEYS.DATA_GAP_END]: civilNow,
    ...(audit.first_ignored_event_at
      ? {}
      : { [BILLING_SYNC_METADATA_KEYS.FIRST_IGNORED_EVENT_AT]: now.toISOString() }),
    ...(audit.data_gap_start ? {} : { [BILLING_SYNC_METADATA_KEYS.DATA_GAP_START]: civilNow }),
  };

  await patchSubscriptionEntitlementMetadata(supabase, ctx.subscriptionId, ctx.metadata, patch, {
    source: "hard_paused_webhook_audit",
  });

  logBilling("billing", "BILLING_HARD_PAUSED_WEBHOOK_IGNORED", {
    subscription_id: ctx.subscriptionId,
    ignored_event_count: ignoredCount,
    marketplace: ctx.marketplace ?? null,
    marketplace_account_id: ctx.marketplaceAccountId ?? null,
  });

  return { ignored_event_count: ignoredCount, acknowledged: true };
}

/**
 * @param {Record<string, unknown>} patchBase
 * @param {string} civilNow
 * @param {Date} now
 */
export function buildHardPausedSyncPatch(patchBase, civilNow, now) {
  return {
    ...patchBase,
    [BILLING_SYNC_METADATA_KEYS.SYNC_STATE]: "HARD_PAUSED",
    [BILLING_SYNC_METADATA_KEYS.PAUSE_STARTED_AT]: now.toISOString(),
    [BILLING_SYNC_METADATA_KEYS.DATA_GAP_START]: civilNow,
    [BILLING_SYNC_METADATA_KEYS.BACKFILL_STATUS]: BILLING_BACKFILL_STATUS.NOT_REQUESTED,
  };
}

/**
 * @param {string} civilNow
 * @param {Date} now
 */
export function buildSyncResumePatch(civilNow, now) {
  return {
    [BILLING_SYNC_METADATA_KEYS.SYNC_STATE]: "FULL",
    [BILLING_SYNC_METADATA_KEYS.SYNC_RESUMED_AT]: now.toISOString(),
    [BILLING_SYNC_METADATA_KEYS.DATA_GAP_END]: civilNow,
    [BILLING_SYNC_METADATA_KEYS.BACKFILL_STATUS]: BILLING_BACKFILL_STATUS.NOT_REQUESTED,
  };
}
