// =============================================================================
// S7 — Observabilidade (S5.10) — registro de prefixos legados (auditoria)
// Não unifica nem redireciona logs — apenas documenta o mapa oficial.
// =============================================================================

import { S7_MOTOR_OBS_EVENT } from "./motorObservabilityContract.js";

/**
 * Mapa prefixo legado → camada do motor.
 */
export const S7_MOTOR_OBS_LOG_PREFIX_REGISTRY = Object.freeze({
  "[S7_NOTIFICATION]": { layer: "core", module: "contract + dispatcher + pipeline" },
  "[S7_ACTIONS]": {
    layer: "actions_engine",
    module: "plan + execute",
    rayx_whatsapp_suffixes: [
      "MANUAL_SALE_RAYX_ROUTE_START",
      "MANUAL_SALE_RAYX_ROUTE_DEDUPE",
      "MANUAL_SALE_RAYX_START",
      "MANUAL_SALE_RAYX_COMPLETE",
      "MANUAL_SALE_RAYX_BATCH_COMPLETE",
      "MANUAL_SALE_RAYX_ROUTE_LIVE_AUDIT",
    ],
    formal_rayx_phase: "S5.12",
  },
  "[S7_EMAIL]": { layer: "channel", channel: "email" },
  "[S7_WHATSAPP]": { layer: "channel", channel: "whatsapp" },
  "[S7_IN_APP]": { layer: "channel", channel: "in_app", note: "legado sininho" },
  "[S7_SININHO]": { layer: "channel", channel: "in_app", formal: "S5.8" },
  "[S7_POPUP]": { layer: "channel", channel: "popup", formal: "S5.7" },
  "[S7_COMMS_PREF]": { layer: "preferences", formal: "S5.9" },
  "[S7_NOTIFICATION_PREF]": { layer: "seller_ui", module: "preferences API" },
  "[S7_NOTIFICATION_RECIPIENT]": { layer: "seller_ui", module: "recipients API" },
  "[S7_NOTIFICATION_UI]": { layer: "seller_ui", module: "categories/hub" },
});

/**
 * Sufixos legados → evento semântico S5.10.
 */
export const S7_MOTOR_OBS_LOG_SUFFIX_MAP = Object.freeze({
  EVENT_PUBLISHED: S7_MOTOR_OBS_EVENT.EVENT_CREATED,
  EVENT_IDEMPOTENT_HIT: S7_MOTOR_OBS_EVENT.EVENT_DEDUPLICATED,
  EVENT_DEDUPE_WINDOW_HIT: S7_MOTOR_OBS_EVENT.EVENT_DEDUPLICATED,
  PIPELINE_IDEMPOTENT_SKIP_DISPATCH: S7_MOTOR_OBS_EVENT.EVENT_DISCARDED,
  PIPELINE_DEDUPE_WINDOW_SKIP_DISPATCH: S7_MOTOR_OBS_EVENT.EVENT_DISCARDED,
  DISPATCHER_RECEIVED: S7_MOTOR_OBS_EVENT.DISPATCH_CREATED,
  DISPATCHER_COMPLETE: S7_MOTOR_OBS_EVENT.DISPATCH_EXECUTED,
  DISPATCHER_FAILED: S7_MOTOR_OBS_EVENT.DISPATCH_FAILED,
  PREFERENCES_RESOLVED: S7_MOTOR_OBS_EVENT.CHANNEL_SELECTED,
  CHANNELS_RESOLVED: S7_MOTOR_OBS_EVENT.CHANNEL_SELECTED,
  RECIPIENTS_RESOLVED: S7_MOTOR_OBS_EVENT.RECIPIENT_RESOLVED,
  SKIPPED_NO_TEMPLATE: S7_MOTOR_OBS_EVENT.CHANNEL_IGNORED,
  SKIPPED_NO_RECIPIENTS: S7_MOTOR_OBS_EVENT.CHANNEL_IGNORED,
  DELIVERED: S7_MOTOR_OBS_EVENT.DELIVERY_COMPLETED,
  DELIVERY_FAILED: S7_MOTOR_OBS_EVENT.DELIVERY_FAILED,
  OUTBOX_ENQUEUED: S7_MOTOR_OBS_EVENT.DELIVERY_STARTED,
  PROCESS_START: S7_MOTOR_OBS_EVENT.DELIVERY_STARTED,
  MANUAL_SALE_RAYX_START: S7_MOTOR_OBS_EVENT.DELIVERY_STARTED,
  MANUAL_SALE_RAYX_COMPLETE: S7_MOTOR_OBS_EVENT.DELIVERY_COMPLETED,
  MANUAL_SALE_RAYX_BATCH_COMPLETE: S7_MOTOR_OBS_EVENT.DELIVERY_COMPLETED,
  RAYX_WHATSAPP_PIPELINE: S7_MOTOR_OBS_EVENT.DELIVERY_COMPLETED,
  FALE_CONOSCO_START: S7_MOTOR_OBS_EVENT.DELIVERY_STARTED,
  FALE_CONOSCO_COMPLETE: S7_MOTOR_OBS_EVENT.DELIVERY_COMPLETED,
  FALE_CONOSCO_PIPELINE: S7_MOTOR_OBS_EVENT.DELIVERY_COMPLETED,
});

/**
 * @param {string} legacySuffix
 */
export function mapLegacyLogSuffixToObservabilityEvent(legacySuffix) {
  const key = String(legacySuffix ?? "").trim().toUpperCase();
  return S7_MOTOR_OBS_LOG_SUFFIX_MAP[key] ?? null;
}
