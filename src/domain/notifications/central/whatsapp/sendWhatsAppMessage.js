// =============================================================================
// API genérica de envio WhatsApp — Fase 3.5C.1.A1
// O motor de notificações e a outbox devem usar apenas esta entrada.
// =============================================================================

export {
  sendS7WhatsApp as sendWhatsAppMessage,
  isRealWhatsAppProviderConfigured,
  isWhatsAppLiveDeliveryActive,
} from "./S7WhatsAppProvider.js";
