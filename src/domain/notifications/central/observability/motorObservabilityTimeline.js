// =============================================================================
// S7 — Observabilidade (S5.10) — timeline oficial (infra, puro)
// Monta visão evento → dispatcher → canal → destinatário → entrega.
// =============================================================================

import { S7_MOTOR_OBS_TIMELINE_STAGE } from "./motorObservabilityContract.js";

/**
 * @param {{
 *   event?: Record<string, unknown> | null;
 *   dispatches?: Record<string, unknown>[];
 *   delivery_logs?: Record<string, unknown>[];
 *   dispatcher_summary?: Record<string, unknown> | null;
 * }} input
 */
export function buildMotorCommunicationTimeline(input = {}) {
  const event = input.event ?? null;
  const dispatches = Array.isArray(input.dispatches) ? input.dispatches : [];
  const deliveryLogs = Array.isArray(input.delivery_logs) ? input.delivery_logs : [];

  /** @type {Array<{ stage: string; at: string | null; status: string | null; refs: Record<string, unknown> }>} */
  const stages = [];

  if (event) {
    stages.push({
      stage: S7_MOTOR_OBS_TIMELINE_STAGE.EVENT,
      at: event.created_at != null ? String(event.created_at) : null,
      status: "published",
      refs: {
        event_id: event.id ?? null,
        category_code: event.category_code ?? null,
        type_key: event.type_key ?? null,
        correlation_id: event.correlation_id ?? null,
      },
    });
  }

  if (input.dispatcher_summary) {
    stages.push({
      stage: S7_MOTOR_OBS_TIMELINE_STAGE.DISPATCHER,
      at: null,
      status: input.dispatcher_summary.final_result != null ? String(input.dispatcher_summary.final_result) : null,
      refs: {
        channel_status: input.dispatcher_summary.channel_status ?? null,
        status_counts: input.dispatcher_summary.status_counts ?? null,
      },
    });
  }

  for (const d of dispatches) {
    stages.push({
      stage: S7_MOTOR_OBS_TIMELINE_STAGE.DISPATCH,
      at: d.created_at != null ? String(d.created_at) : null,
      status: d.status != null ? String(d.status) : null,
      refs: {
        dispatch_id: d.id ?? null,
        channel: d.channel ?? null,
        recipient_id: d.recipient_id ?? null,
        destination_masked: d.destination != null ? "***" : null,
      },
    });
  }

  for (const log of deliveryLogs) {
    stages.push({
      stage: S7_MOTOR_OBS_TIMELINE_STAGE.DELIVERY,
      at: log.created_at != null ? String(log.created_at) : null,
      status: log.status != null ? String(log.status) : null,
      refs: {
        dispatch_id: log.dispatch_id ?? null,
        attempt_number: log.attempt_number ?? null,
        provider_key: log.provider_key ?? null,
      },
    });
  }

  return {
    event_id: event?.id ?? null,
    seller_id: event?.seller_id ?? dispatches[0]?.seller_id ?? null,
    stages,
    dispatch_count: dispatches.length,
    delivery_log_count: deliveryLogs.length,
    answer_chain: [
      S7_MOTOR_OBS_TIMELINE_STAGE.EVENT,
      S7_MOTOR_OBS_TIMELINE_STAGE.DISPATCHER,
      S7_MOTOR_OBS_TIMELINE_STAGE.CHANNEL,
      S7_MOTOR_OBS_TIMELINE_STAGE.RECIPIENT,
      S7_MOTOR_OBS_TIMELINE_STAGE.DELIVERY,
    ],
  };
}
