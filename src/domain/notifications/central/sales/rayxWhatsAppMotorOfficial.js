// =============================================================================
// S7 — Raio-X WhatsApp no Motor Central (Fase S5.12)
// Fonte única de metadados da integração Raio-X → Motor Central.
// NÃO duplica envio, Z-API nem altera contrato HTTP.
// =============================================================================

import { getOfficialWhatsAppChannelSnapshot } from "../whatsapp/whatsappChannelOfficial.js";
import { describeCommunicationDispatcherPipeline } from "../preferences/communicationDispatcherBridge.js";
import {
  S7_COMMUNICATION_CONTRACT_VERSION,
  isSupportedContractVersion,
} from "../contract/index.js";
import {
  S7_RAYX_WHATSAPP_MOTOR_API_PATH,
  S7_RAYX_WHATSAPP_MOTOR_FLOW,
  S7_RAYX_WHATSAPP_MOTOR_PHASE,
  S7_RAYX_WHATSAPP_MOTOR_PIPELINE_STAGES,
} from "./rayxWhatsAppMotorContract.js";
import { describeWhatsAppMultiRecipientPolicy } from "../whatsapp/whatsappMultiRecipient.js";

/**
 * Componentes que permanecem por compatibilidade — candidatos a remoção futura (S5.12).
 * Não remover nesta fase.
 */
export function describeRayxWhatsAppMotorRedundancyCandidates() {
  return [
    {
      id: "manualSaleRayxRecipientTargets.dedupe",
      note: "Implementação homologada; wrapper oficial é dedupeOfficialWhatsAppRecipients (S5.6).",
      action: "manter até migração única de import",
    },
    {
      id: "triggerManualSaleRayxNotification.processWhatsAppOutboxDispatch",
      note: "Processamento síncrono pós-enqueue no handler Raio-X; worker outbox continua válido.",
      action: "manter — comportamento live homologado",
    },
    {
      id: "logNotificationActions.MANUAL_SALE_RAYX_*",
      note: "Logs legados [S7_ACTIONS]; S5.12 adiciona [S7_MOTOR_OBS]_RAYX_WHATSAPP_PIPELINE.",
      action: "manter ambos até consolidação observabilidade",
    },
    {
      id: "manualSaleRayxLiveDelivery.evaluateManualRayxLiveSendPolicy",
      note: "Política live/sandbox específica Raio-X; alinhada a whatsappSandboxPolicy.",
      action: "manter — regras de whitelist/smoke",
    },
  ];
}

/**
 * Snapshot oficial da integração Raio-X WhatsApp (sem secrets).
 */
export function getOfficialRayxWhatsAppMotorSnapshot() {
  const whatsapp = getOfficialWhatsAppChannelSnapshot();
  const dispatcher = describeCommunicationDispatcherPipeline();

  return {
    phase: S7_RAYX_WHATSAPP_MOTOR_PHASE,
    motor_central_single_source: true,
    parallel_motor: false,
    seller_ux_unchanged: true,
    api_path: S7_RAYX_WHATSAPP_MOTOR_API_PATH,
    flow: S7_RAYX_WHATSAPP_MOTOR_FLOW,
    contract: {
      version: S7_COMMUNICATION_CONTRACT_VERSION,
      supported: isSupportedContractVersion(S7_COMMUNICATION_CONTRACT_VERSION),
      publish: "publishNotificationEvent → buildCommunicationEventEnvelope + validateCommunicationEvent",
    },
    dispatcher,
    pipeline_stages: [...S7_RAYX_WHATSAPP_MOTOR_PIPELINE_STAGES],
    pipeline_sequence:
      "Modal Raio-X → sendSaleRayxWhatsAppShare → POST sale-rayx → publishNotificationEvent → runCentralDispatcher → runNotificationActionsEngine → s7_notification_whatsapp_outbox → processWhatsAppOutboxDispatch → Z-API → destinatário",
    whatsapp_channel: {
      official: true,
      provider: whatsapp.configured_provider,
      live_delivery_active: whatsapp.live_delivery_active,
      multi_recipient: describeWhatsAppMultiRecipientPolicy(),
      manual_sale_rayx: whatsapp.manual_sale_rayx,
    },
    preserved_capabilities: {
      multi_recipient: true,
      deduplication: true,
      sandbox_whitelist: true,
      smoke_destination: true,
      live_delivery: true,
      share_image_base64: true,
      idempotency_window_minutes: 5,
      history_tables: [
        "s7_notification_events",
        "s7_notification_dispatches",
        "s7_notification_whatsapp_outbox",
        "s7_notification_delivery_logs",
      ],
    },
    observability: {
      legacy_prefix: "[S7_ACTIONS]_MANUAL_SALE_RAYX_*",
      formal_prefix: "[S7_MOTOR_OBS]_RAYX_WHATSAPP_PIPELINE",
      timeline_builder: "buildRayxWhatsAppMotorTimeline",
      integrated_phase: "S5.10",
    },
    redundancy_candidates: describeRayxWhatsAppMotorRedundancyCandidates(),
  };
}

/**
 * Valida que o fluxo está declarado como integrado ao motor (smoke de contrato).
 */
export function evaluateOfficialRayxWhatsAppMotorIntegration() {
  const snap = getOfficialRayxWhatsAppMotorSnapshot();
  return {
    ok:
      snap.motor_central_single_source === true &&
      snap.parallel_motor === false &&
      snap.whatsapp_channel.manual_sale_rayx?.preserved === true &&
      snap.pipeline_stages.includes("central_dispatcher") &&
      snap.pipeline_stages.includes("zapi_provider"),
    snapshot: snap,
  };
}
