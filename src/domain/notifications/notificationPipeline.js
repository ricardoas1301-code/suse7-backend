// ============================================================
// Pipeline — evento → deliveries (orquestra dedupe + inserts)
// Ponto de entrada para jobs/domínio ao detectar alertas (Fase 2).
// ============================================================

import { NOTIFICATION_ROUTING_TYPE_LOOKUP, isValidRoutingNotificationType } from "../notificationRoutingCatalog.js";
import { buildNotificationFingerprint } from "./notificationFingerprint.js";
import { severityFromCatalogPriority } from "./notificationSeverity.js";
import { shouldCreateNotificationEvent } from "./dedupeNotificationEvent.js";
import { insertNotificationEvent } from "./createNotificationEvent.js";
import { createNotificationDeliveriesForEvent } from "./createNotificationDeliveries.js";
import { logNotification } from "./notificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string,
 *   notificationType: string,
 *   title: string,
 *   message: string,
 *   marketplace?: string | null,
 *   marketplaceAccountId?: string | null,
 *   sellerCompanyId?: string | null,
 *   entityType?: string | null,
 *   entityId?: string | null,
 *   payload?: Record<string, unknown>,
 *   relevanceKey?: string | null,
 *   skipDedupe?: boolean,
 *   eventSeverity?: 'critical'|'important'|'medium'|'info'|null,
 * }} dto
 */
export async function ingestNotificationEvent(supabase, dto) {
  const userId = String(dto.userId ?? "").trim();
  const notificationType = String(dto.notificationType ?? "").trim();

  if (!userId || !isValidRoutingNotificationType(notificationType)) {
    return { ok: false, error: "INVALID_INPUT" };
  }

  const catalog = NOTIFICATION_ROUTING_TYPE_LOOKUP[notificationType];
  const canonical = new Set(["critical", "important", "medium", "info"]);
  const override =
    dto.eventSeverity != null && canonical.has(String(dto.eventSeverity).trim().toLowerCase())
      ? String(dto.eventSeverity).trim().toLowerCase()
      : null;
  const severity = override ?? severityFromCatalogPriority(catalog?.priority ?? "info");

  const fingerprint = buildNotificationFingerprint({
    notificationType,
    marketplaceAccountId: dto.marketplaceAccountId ?? null,
    entityType: dto.entityType ?? null,
    entityId: dto.entityId ?? null,
    relevanceKey: dto.relevanceKey ?? null,
  });

  const dedupe = await shouldCreateNotificationEvent(supabase, {
    userId,
    fingerprint,
    severity,
    skipDedupe: Boolean(dto.skipDedupe),
  });

  if (!dedupe.allow) {
    logNotification("EVENT_SKIPPED_DEDUPE", {
      user_id: userId,
      notification_type: notificationType,
      reason: dedupe.reason,
    });
    return { ok: true, skipped: true, reason: dedupe.reason, fingerprint };
  }

  const mergedPayload =
    dto.payload && typeof dto.payload === "object" && !Array.isArray(dto.payload)
      ? { ...dto.payload }
      : {};

  const inserted = await insertNotificationEvent(supabase, {
    user_id: userId,
    notification_type: notificationType,
    marketplace: dto.marketplace ?? null,
    marketplace_account_id: dto.marketplaceAccountId ?? null,
    seller_company_id: dto.sellerCompanyId ?? null,
    entity_type: dto.entityType ?? null,
    entity_id: dto.entityId ?? null,
    title: dto.title,
    message: dto.message,
    payload: mergedPayload,
    fingerprint,
    severity,
  });

  if (!inserted.ok || !inserted.event) {
    return { ok: false, error: inserted.error ?? "EVENT_INSERT_FAILED" };
  }

  const deliveries = await createNotificationDeliveriesForEvent(supabase, inserted.event);
  if (!deliveries.ok) {
    return { ok: false, error: deliveries.error ?? "DELIVERIES_FAILED", event: inserted.event };
  }

  return {
    ok: true,
    event: inserted.event,
    deliveries_inserted: deliveries.inserted ?? 0,
    fingerprint,
  };
}
