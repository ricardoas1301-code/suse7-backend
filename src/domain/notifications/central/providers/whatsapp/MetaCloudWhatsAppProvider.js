// =============================================================================
// MetaCloudWhatsAppProvider — contrato Meta Cloud API (Fase 3.5C.1.A1, stub)
// =============================================================================

import { LiveWhatsAppAdapterBase } from "./adapters/LiveWhatsAppAdapterBase.js";
import { WHATSAPP_PROVIDER_NAMES } from "./whatsappProviderEnv.js";

/**
 * Meta WhatsApp Cloud API — WHATSAPP_PROVIDER=meta_cloud
 * HTTP Graph API: fase futura; hoje PROVIDER_NOT_READY (stub live).
 */
export class MetaCloudWhatsAppProvider extends LiveWhatsAppAdapterBase {
  constructor() {
    super(WHATSAPP_PROVIDER_NAMES.META_CLOUD);
  }
}
