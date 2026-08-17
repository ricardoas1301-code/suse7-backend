// =============================================================================
// Event bus central — publishNotificationEvent()
// Todos os módulos S7 devem publicar aqui (nunca enviar email/WhatsApp direto).
//
// Fase S5.1 — Contrato Global de Comunicação:
// a publicação agora passa pelo Communication Event Model oficial
// (builder + validator) e suporta versionamento, metadata padronizada e
// deduplicação por janela — preservando 100% do comportamento legado.
// =============================================================================

import { buildCommunicationEventEnvelope } from "../contract/communicationEventEnvelope.js";
import { validateCommunicationEvent } from "../contract/validateCommunicationEvent.js";
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
 *   priority?: string;
 *   correlation_id?: string | null;
 *   idempotency_key?: string | null;
 *   dedupe_key?: string | null;
 *   dedupe_window_seconds?: number | null;
 *   contract_version?: number | null;
 *   metadata?: Record<string, unknown> | null;
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   entity_type?: string | null;
 *   entity_id?: string | null;
 *   source_module?: string | null;
 *   source_event?: string | null;
 *   skip_dispatch?: boolean;
 *   force_redispatch?: boolean;
 *   dispatch_options?: {
 *     channels_filter?: string[];
 *     manual_recipients_by_channel?: Record<string, { destination?: string; recipient_id?: string | null }>;
 *   };
 * }} input
 */
export async function publishNotificationEvent(supabase, input) {
  // 1. Monta o envelope canônico do Communication Event Model.
  const envelope = buildCommunicationEventEnvelope(input);

  // 2. Valida contra o contrato oficial (códigos compatíveis com o legado).
  const validation = validateCommunicationEvent(envelope);
  if (!validation.ok) {
    return { ok: false, error: validation.primaryError ?? "INVALID_EVENT", errors: validation.errors };
  }

  // 3. Persiste (idempotência por chave + dedupe por janela são tratados no insert).
  const inserted = await insertCentralNotificationEvent(supabase, {
    sellerId: envelope.seller_id,
    category: envelope.category,
    type: envelope.type,
    severity: envelope.severity,
    payload: envelope.payload,
    correlationId: envelope.correlation_id,
    idempotencyKey: envelope.idempotency_key,
    contractVersion: envelope.contract_version,
    metadata: envelope.metadata,
    dedupeKey: envelope.dedupe_key,
    dedupeWindowSeconds: envelope.dedupe_window_seconds,
    marketplace: envelope.marketplace,
    marketplaceAccountId: envelope.marketplace_account_id,
    sellerCompanyId: envelope.seller_company_id,
    entityType: envelope.entity_type,
    entityId: envelope.entity_id,
    sourceModule: envelope.source_module,
  });

  if (!inserted.ok || !inserted.event) {
    return { ok: false, error: inserted.error ?? "EVENT_FAILED" };
  }

  // Evento absorvido por dedupe de janela não dispara pipeline (publicação idêntica recente).
  const isDeduped = inserted.deduped === true;
  // Replay idempotente exato também não redispatcha (salvo force_redispatch).
  const isIdempotentReplay = inserted.idempotent === true && input.force_redispatch !== true;

  if (input.skip_dispatch || isDeduped || isIdempotentReplay) {
    if (isDeduped) {
      logCentralNotification("PIPELINE_DEDUPE_WINDOW_SKIP_DISPATCH", {
        event_id: inserted.event.id,
        seller_id: envelope.seller_id,
        category: envelope.category,
        type: envelope.type,
        dedupe_key: envelope.dedupe_key,
        dedupe_window_seconds: envelope.dedupe_window_seconds,
      });
    } else if (isIdempotentReplay) {
      logCentralNotification("PIPELINE_IDEMPOTENT_SKIP_DISPATCH", {
        event_id: inserted.event.id,
        seller_id: envelope.seller_id,
        category: envelope.category,
        type: envelope.type,
        idempotency_key: envelope.idempotency_key,
      });
    }

    return {
      ok: true,
      event: inserted.event,
      idempotent: inserted.idempotent === true,
      deduped: isDeduped,
      dispatches: {
        inserted: 0,
        skipped_engine: true,
        reason: isDeduped
          ? "DEDUPE_WINDOW_HIT"
          : isIdempotentReplay
            ? "IDEMPOTENT_EVENT_REPLAY"
            : "SKIP_DISPATCH_REQUESTED",
      },
    };
  }

  const dispatch = await runNotificationDispatchEngine(supabase, inserted.event, {
    allow_redispatch: input.force_redispatch === true,
    ...(input.dispatch_options && typeof input.dispatch_options === "object"
      ? input.dispatch_options
      : {}),
  });

  logCentralNotification("PIPELINE_COMPLETE", {
    event_id: inserted.event.id,
    seller_id: envelope.seller_id,
    category: envelope.category,
    type: envelope.type,
    dispatches_inserted: dispatch.inserted,
    idempotent: inserted.idempotent === true,
    force_redispatch: input.force_redispatch === true,
  });

  return {
    ok: true,
    event: inserted.event,
    idempotent: inserted.idempotent === true,
    deduped: false,
    dispatches: dispatch,
  };
}
