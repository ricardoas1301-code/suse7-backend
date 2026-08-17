import {
  buildToolboxOperationalAuditContext,
  deriveAdminDisplayNameFromEmail,
  mapAuditStatusToTimelineSeverity,
  resolveToolboxOperationLabel,
} from "./devCenterToolboxOperationalAuditModel.js";
import { listarAuditoriaOperacionalToolbox } from "./devCenterToolboxOperationalAuditService.js";

/**
 * @param {Record<string, unknown>} row
 */
export function mapAuditRowToTimelineEvent(row) {
  const operationType = String(row.operation_type ?? "");
  const status = /** @type {"success" | "error" | "blocked"} */ (row.status ?? "success");
  const beforeState =
    row.before_state && typeof row.before_state === "object" ? row.before_state : {};
  const afterState = row.after_state && typeof row.after_state === "object" ? row.after_state : {};
  const changedFields = Array.isArray(row.changed_fields) ? row.changed_fields : [];
  const hasBeforeAfter = changedFields.length > 0 || Object.keys(beforeState).length > 0 || Object.keys(afterState).length > 0;

  return {
    eventId: String(row.id),
    eventType: operationType,
    eventLabel: resolveToolboxOperationLabel(operationType),
    category: row.category != null ? String(row.category) : null,
    entityType: row.entity_type != null ? String(row.entity_type) : "general",
    entityId: row.entity_id != null ? String(row.entity_id) : "—",
    adminName: deriveAdminDisplayNameFromEmail(row.operator_email),
    adminEmail: row.operator_email != null ? String(row.operator_email) : "",
    operatorUserId: row.operator_user_id != null ? String(row.operator_user_id) : null,
    createdAt: row.created_at != null ? String(row.created_at) : new Date().toISOString(),
    reason: row.reason != null ? String(row.reason) : "",
    status,
    severity: mapAuditStatusToTimelineSeverity(status, operationType),
    subscriptionId: row.subscription_id != null ? String(row.subscription_id) : null,
    marketplaceAccountId: row.marketplace_account_id != null ? String(row.marketplace_account_id) : null,
    changedFields,
    beforeAfter: hasBeforeAfter ? { before: beforeState, after: afterState } : null,
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    errorCode: row.error_code != null ? String(row.error_code) : null,
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapAuditRowToHistoryEntry(row) {
  const timeline = mapAuditRowToTimelineEvent(row);
  return {
    ...timeline,
    auditId: timeline.eventId,
    operationType: timeline.eventType,
    operationLabel: timeline.eventLabel,
    timestamp: timeline.createdAt,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{ limit?: number }} [opts]
 */
export async function listarTimelineOperacionalSellerDevCenter(supabase, sellerId, opts = {}) {
  const rows = await listarAuditoriaOperacionalToolbox(supabase, sellerId, opts);
  const events = rows.map((row) => mapAuditRowToTimelineEvent(row));

  const adminIds = new Set(events.map((e) => e.operatorUserId).filter(Boolean));
  const latest = events[0] ?? null;

  return {
    events,
    summary: {
      totalEvents: events.length,
      adminsInvolved: adminIds.size,
      lastEventLabel: latest?.eventLabel ?? "—",
      lastEventAt: latest?.createdAt ?? null,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{ limit?: number }} [opts]
 */
export async function listarHistoricoAdministrativoSellerDevCenter(supabase, sellerId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const rows = await listarAuditoriaOperacionalToolbox(supabase, sellerId, { limit });
  return {
    entries: rows.map((row) => mapAuditRowToHistoryEntry(row)),
    total: rows.length,
  };
}

/**
 * Helpers para montar snapshots before/after nas operações.
 */

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Record<string, unknown>} meta
 */
export function buildSubscriptionBeforeSnapshot(subscription, meta) {
  return sanitizeSnapshot({
    status: subscription?.status ?? null,
    plan_key: subscription?.plan_key ?? null,
    current_period_end: subscription?.current_period_end ?? null,
    trial_ends_at: meta?.trial_ends_at ?? null,
    extra_days_total: meta?.admin_extra_days_total ?? null,
    extra_sales_bonus: meta?.admin_extra_sales_bonus ?? null,
  });
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} result
 * @param {string} actionId
 */
export function buildSubscriptionAfterSnapshot(before, result, actionId) {
  /** @type {Record<string, unknown>} */
  const after = { ...before };

  if (actionId === "enable_trial") {
    after.status = "trialing";
    after.trialStatus = result.trialStatus ?? "active";
    after.trial_ends_at = result.trialEndsAt ?? after.trial_ends_at;
  } else if (actionId === "end_trial") {
    after.trialStatus = result.trialStatus ?? "ended";
    after.trial_ends_at = null;
  } else if (actionId === "add_subscription_days") {
    after.current_period_end = result.currentPeriodEnd ?? after.current_period_end;
    after.extra_days_total = result.addedDays ?? after.extra_days_total;
  } else if (actionId === "add_subscription_sales") {
    after.extra_sales_bonus = result.extraSalesBonus ?? after.extra_sales_bonus;
  } else if (actionId === "reset_consumption" || actionId === "recalculate_consumption") {
    after.consumed = result.newConsumed ?? result.consumed ?? after.consumed;
    after.previousConsumed = result.previousConsumed ?? null;
  }

  return sanitizeSnapshot(after);
}

/**
 * @param {Record<string, unknown> | null | undefined} snapshot
 */
function sanitizeSnapshot(snapshot) {
  return buildToolboxOperationalAuditContext({
    operationType: "snapshot",
    beforeState: snapshot ?? {},
    afterState: {},
  }).beforeState;
}
