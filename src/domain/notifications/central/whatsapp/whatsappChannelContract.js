// =============================================================================
// S7 — Canal WhatsApp Oficial (Fase S5.6)
// Contrato operacional do canal — infraestrutura, sem template de negócio.
//
// Envio real: S7WhatsAppProvider + whatsappProviderResolver + outbox + worker.
// Raio-X manual: POST /api/notifications/manual/sale-rayx (preservado).
// =============================================================================

/** Providers suportados pelo motor (estratégia multi-provider). */
export const S7_WHATSAPP_OFFICIAL_PROVIDER = Object.freeze({
  MOCK: "mock",
  ZAPI: "zapi",
  META_CLOUD: "meta_cloud",
  META: "meta",
  EVOLUTION: "evolution",
  TWILIO: "twilio",
});

/** Provider oficial homologado em produção (Z-API). */
export const S7_WHATSAPP_OFFICIAL_PROVIDER_DEFAULT = S7_WHATSAPP_OFFICIAL_PROVIDER.ZAPI;

/** Modos de operação do canal. */
export const S7_WHATSAPP_OFFICIAL_MODE = Object.freeze({
  MOCK: "mock",
  SIMULATE: "simulate",
  DEV_SANDBOX: "dev_sandbox",
  SANDBOX: "sandbox",
  LIVE: "live",
  PRODUCTION: "production",
});

/** Rota interna do worker de outbox (integração com dispatcher). */
export const S7_WHATSAPP_OUTBOX_WORKER_PATH = "/api/internal/notifications/whatsapp/process";

/** Rota pública do acionamento manual Raio-X (homologado — não alterar contrato). */
export const S7_WHATSAPP_MANUAL_RAYX_API_PATH = "/api/notifications/manual/sale-rayx";

/** Identificadores do fluxo manual Raio-X no motor. */
export const S7_WHATSAPP_MANUAL_RAYX_FLOW = Object.freeze({
  FLOW: "manual_sale_rayx",
  SOURCE_MODULE: "sale_rayx_modal",
  EVENT_TYPE: "MANUAL_SALE_RAYX",
  CATEGORY: "SALES",
});

/**
 * Providers registrados para troca futura sem refatorar o motor.
 * @type {readonly string[]}
 */
export const S7_WHATSAPP_PROVIDER_REGISTRY_ORDER = Object.freeze([
  S7_WHATSAPP_OFFICIAL_PROVIDER.ZAPI,
  S7_WHATSAPP_OFFICIAL_PROVIDER.META_CLOUD,
  S7_WHATSAPP_OFFICIAL_PROVIDER.META,
  S7_WHATSAPP_OFFICIAL_PROVIDER.EVOLUTION,
  S7_WHATSAPP_OFFICIAL_PROVIDER.TWILIO,
  S7_WHATSAPP_OFFICIAL_PROVIDER.MOCK,
]);
