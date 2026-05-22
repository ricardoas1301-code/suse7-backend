// =============================================================================
// Event bus central — publishNotificationEvent()
// Todos os módulos S7 devem publicar aqui (nunca enviar email/WhatsApp direto).
// =============================================================================

import { isValidNotificationCategory } from "../constants/categories.js";
import { isValidCentralNotificationType, lookupNotificationTypeCatalog } from "../constants/eventTypes.js";
import { runNotificationDispatchEngine } from "../dispatches/notificationDispatchEngine.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";
import { insertCentralNotificationEvent } from "./insertCentralNotificationEvent.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   category: string;
 *   type: string;
 *   seller_id: string;
 *   payload?: Record<string, unknown>;
 *   severity?: string;
 *   correlation_id?: string | null;
 *   idempotency_key?: string | null;
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   entity_type?: string | null;
 *   entity_id?: string | null;
 *   source_module?: string | null;
 *   skip_dispatch?: boolean;
 *   force_redispatch?: boolean;
 * }} input
 */
export async function publishNotificationEvent(supabase, input) {
  const sellerId = String(input.seller_id ?? "").trim();
  const category = String(input.category ?? "").trim();
  const type = String(input.type ?? "").trim();

  if (!sellerId) {
    return { ok: false, error: "MISSING_SELLER_ID" };
  }
  if (!isValidNotificationCategory(category)) {
    return { ok: false, error: "INVALID_CATEGORY" };
  }
  if (!isValidCentralNotificationType(category, type)) {
    return { ok: false, error: "INVALID_TYPE" };
  }

  const catalog = lookupNotificationTypeCatalog(category, type);
  const correlationId = input.correlation_id != null ? String(input.correlation_id) : null;
  const idempotencyKey =
    input.idempotency_key != null && String(input.idempotency_key).trim() !== ""
      ? String(input.idempotency_key).trim()
      : `s7:${category}:${type}:${correlationId ?? sellerId}:${Date.now()}`;

  const severity =
    input.severity != null && String(input.severity).trim() !== ""
      ? String(input.severity).trim()
      : catalog?.severity ?? "info";

  const inserted = await insertCentralNotificationEvent(supabase, {
    sellerId,
    category,
    type,
    severity,
    payload: input.payload ?? {},
    correlationId,
    idempotencyKey,
    marketplace: input.marketplace ?? null,
    marketplaceAccountId: input.marketplace_account_id ?? null,
    sellerCompanyId: input.seller_company_id ?? null,
    entityType: input.entity_type ?? null,
    entityId: input.entity_id != null ? String(input.entity_id) : null,
    sourceModule: input.source_module ?? null,
  });

  if (!inserted.ok || !inserted.event) {
    return { ok: false, error: inserted.error ?? "EVENT_FAILED" };
  }

  if (input.skip_dispatch) {
    return {
      ok: true,
      event: inserted.event,
      idempotent: inserted.idempotent,
      dispatches: { inserted: 0, skipped_engine: true },
    };
  }

  const isIdempotentReplay = inserted.idempotent === true && input.force_redispatch !== true;

  if (isIdempotentReplay) {
    logCentralNotification("PIPELINE_IDEMPOTENT_SKIP_DISPATCH", {
      event_id: inserted.event.id,
      seller_id: sellerId,
      category,
      type,
      idempotency_key: idempotencyKey,
    });

    return {
      ok: true,
      event: inserted.event,
      idempotent: true,
      dispatches: {
        inserted: 0,
        skipped_engine: true,
        reason: "IDEMPOTENT_EVENT_REPLAY",
      },
    };
  }

  const dispatch = await runNotificationDispatchEngine(supabase, inserted.event, {
    allow_redispatch: input.force_redispatch === true,
  });

  logCentralNotification("PIPELINE_COMPLETE", {
    event_id: inserted.event.id,
    seller_id: sellerId,
    category,
    type,
    dispatches_inserted: dispatch.inserted,
    idempotent: inserted.idempotent,
    force_redispatch: input.force_redispatch === true,
  });

  return {
    ok: true,
    event: inserted.event,
    idempotent: inserted.idempotent,
    dispatches: dispatch,
  };
}
