// =============================================================================
// S7 — Raio-X WhatsApp no Motor Central (Fase S5.12)
// Contrato oficial de integração — sem alterar UX nem payloads da API.
// =============================================================================

import { S7_WHATSAPP_MANUAL_RAYX_API_PATH, S7_WHATSAPP_MANUAL_RAYX_FLOW } from "../whatsapp/whatsappChannelContract.js";
import { S7_NOTIFICATION_CATEGORY } from "../constants/categories.js";

export const S7_RAYX_WHATSAPP_MOTOR_PHASE = "S5.12";

export const S7_RAYX_WHATSAPP_MOTOR_API_PATH = S7_WHATSAPP_MANUAL_RAYX_API_PATH;

export const S7_RAYX_WHATSAPP_MOTOR_FLOW = Object.freeze({
  ...S7_WHATSAPP_MANUAL_RAYX_FLOW,
  CATEGORY: S7_NOTIFICATION_CATEGORY.SALES,
  TYPE_KEY: "MANUAL_SALE_RAYX",
  TEMPLATE_KEY: "sales.manual.rayx",
  SOURCE_MODULE: "sale_rayx_modal",
  FRONTEND_ADAPTER: "sendSaleRayxWhatsAppShare",
  FRONTEND_API_CLIENT: "postSaleRayxManualNotification",
});

/** Estágios oficiais do pipeline (fonte única para auditoria S5.12). */
export const S7_RAYX_WHATSAPP_MOTOR_PIPELINE_STAGES = Object.freeze([
  "modal_ui",
  "frontend_api_post",
  "api_route_sale_rayx",
  "communication_contract_publish",
  "central_dispatcher",
  "actions_engine",
  "preferences_channels",
  "whatsapp_channel_outbox",
  "whatsapp_live_process",
  "zapi_provider",
  "recipient",
]);
