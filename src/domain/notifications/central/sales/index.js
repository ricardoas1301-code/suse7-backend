// =============================================================================
// S7 — Vendas / Raio-X no Motor Central
// =============================================================================

export {
  S7_RAYX_WHATSAPP_MOTOR_PHASE,
  S7_RAYX_WHATSAPP_MOTOR_API_PATH,
  S7_RAYX_WHATSAPP_MOTOR_FLOW,
  S7_RAYX_WHATSAPP_MOTOR_PIPELINE_STAGES,
} from "./rayxWhatsAppMotorContract.js";

export {
  getOfficialRayxWhatsAppMotorSnapshot,
  evaluateOfficialRayxWhatsAppMotorIntegration,
  describeRayxWhatsAppMotorRedundancyCandidates,
} from "./rayxWhatsAppMotorOfficial.js";

export {
  buildRayxWhatsAppMotorTimeline,
  recordRayxWhatsAppMotorObservability,
} from "./rayxWhatsAppMotorObservability.js";

export { triggerManualSaleRayxNotification, triggerManualSaleRayxNotificationsBatch } from "./triggerManualSaleRayxNotification.js";
