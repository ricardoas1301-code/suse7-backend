// =============================================================================
// S7 — Fale Conosco (S5.13) — observabilidade S5.10
// =============================================================================

import { buildMotorCommunicationTimeline } from "../observability/motorObservabilityTimeline.js";
import { logMotorObservability } from "../observability/motorObservabilityLog.js";
import { S7_FALE_CONOSCO_FLOW } from "./faleConoscoMotorContract.js";

/**
 * @param {Parameters<typeof buildMotorCommunicationTimeline>[0] & {
 *   leg?: "team" | "confirmation";
 * }} input
 */
export function buildFaleConoscoMotorTimeline(input = {}) {
  return buildMotorCommunicationTimeline(input);
}

/**
 * @param {{
 *   leg: "team" | "confirmation";
 *   event_id?: string | null;
 *   dispatch_id?: string | null;
 *   outbox_id?: string | null;
 *   status?: string | null;
 *   provider_key?: string | null;
 *   real_send_executed?: boolean;
 * }} input
 */
export function recordFaleConoscoMotorObservability(input) {
  const timeline = buildFaleConoscoMotorTimeline({
    event: input.event_id
      ? {
          id: input.event_id,
          category_code: S7_FALE_CONOSCO_FLOW.CATEGORY,
          type_key:
            input.leg === "team"
              ? S7_FALE_CONOSCO_FLOW.TYPE_TEAM
              : S7_FALE_CONOSCO_FLOW.TYPE_CONFIRMATION,
        }
      : null,
    dispatches: input.dispatch_id
      ? [{ id: input.dispatch_id, channel: "email", status: input.status ?? null }]
      : [],
    delivery_logs: input.outbox_id
      ? [
          {
            dispatch_id: input.dispatch_id,
            status: input.real_send_executed ? "sent" : input.status ?? "pending",
            provider_key: input.provider_key ?? null,
          },
        ]
      : [],
  });

  logMotorObservability("FALE_CONOSCO_PIPELINE", {
    flow: S7_FALE_CONOSCO_FLOW.FLOW,
    leg: input.leg,
    timeline,
    real_send_executed: input.real_send_executed === true,
    dispatch_id: input.dispatch_id ?? null,
    event_id: input.event_id ?? null,
  });
}
