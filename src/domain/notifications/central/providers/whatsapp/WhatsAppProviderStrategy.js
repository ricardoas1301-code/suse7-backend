// =============================================================================
// WhatsAppProviderStrategy — contrato multi-provider (Fase 3.5C.1.A1)
// Extensão documentada de ProviderAdapter; implementações: Z-API, Meta Cloud, …
// =============================================================================

import { ProviderAdapter } from "../abstraction/ProviderAdapter.js";

/**
 * Estratégia de envio WhatsApp. O motor chama apenas sendWhatsAppMessage();
 * adapters concretos implementam send/health/validate.
 */
export class WhatsAppProviderStrategy extends ProviderAdapter {}
