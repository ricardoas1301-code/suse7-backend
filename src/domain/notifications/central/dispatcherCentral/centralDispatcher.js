// =============================================================================
// S7 — Dispatcher Central (Fase S5.2)
// Entrada única do Dispatcher Central.
//
// NÃO é um motor paralelo: consolida o fluxo existente (Notification Actions
// Engine) como o "Dispatcher Central" oficial, adicionando observabilidade de
// ponta a ponta e o resumo de status por canal / resultado final.
//
// Consome eventos JÁ NORMALIZADOS pelo Contrato Global (S5.1).
// Preserva o contrato de retorno do motor (ok, inserted, skipped_duplicates,
// dispatches, planned_actions) e apenas ENRIQUECE com channel_status/final_result.
// =============================================================================

import { runNotificationActionsEngine } from "../actions/notificationActionsEngine.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";
import { summarizeChannelStatusFromDispatches } from "./dispatchStatusSummary.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event — linha persistida em s7_notification_events (Contrato Global)
 * @param {{ locale?: string; allow_redispatch?: boolean; channels_filter?: string[]; manual_recipients_by_channel?: Record<string, unknown> }} [options]
 */
export async function runCentralDispatcher(supabase, event, options = {}) {
  const eventId = event?.id != null ? String(event.id) : null;
  const sellerId = event?.seller_id != null ? String(event.seller_id) : null;
  const category = event?.category_code != null ? String(event.category_code) : null;
  const type = event?.type_key != null ? String(event.type_key) : null;

  logCentralNotification("DISPATCHER_RECEIVED", {
    event_id: eventId,
    seller_id: sellerId,
    category,
    type,
    allow_redispatch: options.allow_redispatch === true,
    channels_filter: Array.isArray(options.channels_filter) ? options.channels_filter : null,
  });

  const result = await runNotificationActionsEngine(supabase, event, options);

  if (!result?.ok) {
    logCentralNotification("DISPATCHER_FAILED", {
      event_id: eventId,
      seller_id: sellerId,
      error: result?.error ?? "UNKNOWN",
    });
    return result;
  }

  const summary = summarizeChannelStatusFromDispatches(
    Array.isArray(result.dispatches) ? result.dispatches : []
  );

  logCentralNotification("DISPATCHER_COMPLETE", {
    event_id: eventId,
    seller_id: sellerId,
    category,
    type,
    inserted: result.inserted ?? 0,
    skipped_duplicates: result.skipped_duplicates ?? 0,
    channels: Object.keys(summary.channels),
    status_counts: summary.status_counts,
    final_result: summary.final_result,
  });

  // Enriquecimento aditivo — não remove nenhum campo legado do retorno.
  return {
    ...result,
    channel_status: summary.channels,
    status_counts: summary.status_counts,
    final_result: summary.final_result,
  };
}
