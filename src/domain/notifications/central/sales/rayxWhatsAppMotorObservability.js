// =============================================================================
// S7 — Raio-X WhatsApp (S5.12) — observabilidade integrada S5.10
// Logs adicionais; não altera resposta HTTP nem UX.
// =============================================================================

import { buildMotorCommunicationTimeline } from "../observability/motorObservabilityTimeline.js";
import { logMotorObservability } from "../observability/motorObservabilityLog.js";
import { buildWhatsAppDeliveryTraceSummary } from "../whatsapp/whatsappDeliveryTrace.js";
import { S7_RAYX_WHATSAPP_MOTOR_FLOW } from "./rayxWhatsAppMotorContract.js";

/**
 * Monta timeline evento → dispatcher → canal → destinatário → entrega (read-model).
 * @param {{
 *   event_id?: string | null;
 *   dispatch_id?: string | null;
 *   outbox_id?: string | null;
 *   seller_id?: string | null;
 *   correlation_id?: string | null;
 *   status?: string | null;
 *   channel?: string | null;
 *   provider_key?: string | null;
 *   provider_message_id?: string | null;
 *   real_send_executed?: boolean;
 *   multi?: boolean;
 *   dispatches_created?: number;
 * }} input
 */
export function buildRayxWhatsAppMotorTimeline(input = {}) {
  const dispatchRow =
    input.dispatch_id != null
      ? {
          id: input.dispatch_id,
          channel: input.channel ?? "whatsapp",
          status: input.status ?? null,
          seller_id: input.seller_id ?? null,
          created_at: null,
        }
      : null;

  const eventRow =
    input.event_id != null
      ? {
          id: input.event_id,
          seller_id: input.seller_id ?? null,
          category_code: S7_RAYX_WHATSAPP_MOTOR_FLOW.CATEGORY,
          type_key: S7_RAYX_WHATSAPP_MOTOR_FLOW.TYPE_KEY,
          correlation_id: input.correlation_id ?? null,
          created_at: null,
        }
      : null;

  const deliveryLogs =
    input.outbox_id != null || input.provider_message_id != null
      ? [
          {
            dispatch_id: input.dispatch_id ?? null,
            status: input.real_send_executed ? "sent" : input.status ?? "pending",
            provider_key: input.provider_key ?? null,
            created_at: null,
          },
        ]
      : [];

  return buildMotorCommunicationTimeline({
    event: eventRow,
    dispatches: dispatchRow ? [dispatchRow] : [],
    delivery_logs: deliveryLogs,
    dispatcher_summary: {
      final_result: input.real_send_executed ? "delivered" : input.status ?? "queued",
      channel_status: { whatsapp: input.status ?? null },
    },
  });
}

/**
 * Registra rastreio S5.10 para uma entrega Raio-X WhatsApp (console apenas).
 * @param {Parameters<typeof buildRayxWhatsAppMotorTimeline>[0] & {
 *   route?: "single" | "batch";
 *   live_process_reason?: string | null;
 * }} input
 */
export function recordRayxWhatsAppMotorObservability(input = {}) {
  const timeline = buildRayxWhatsAppMotorTimeline(input);
  const whatsappTrace = buildWhatsAppDeliveryTraceSummary({
    event_id: input.event_id ?? null,
    dispatch_id: input.dispatch_id ?? null,
    outbox_id: input.outbox_id ?? null,
    seller_id: input.seller_id ?? null,
    correlation_id: input.correlation_id ?? null,
    status: input.status ?? null,
    provider: input.provider_key ?? null,
    provider_message_id: input.provider_message_id ?? null,
  });

  logMotorObservability("RAYX_WHATSAPP_PIPELINE", {
    flow: S7_RAYX_WHATSAPP_MOTOR_FLOW.FLOW,
    source_module: S7_RAYX_WHATSAPP_MOTOR_FLOW.SOURCE_MODULE,
    route: input.route ?? "single",
    multi: input.multi === true,
    dispatches_created: input.dispatches_created ?? null,
    real_send_executed: input.real_send_executed === true,
    live_process_reason: input.live_process_reason ?? null,
    timeline,
    whatsapp_trace: whatsappTrace,
  });
}
