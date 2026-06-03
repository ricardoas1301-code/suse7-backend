// =============================================================================
// S7 — Canal WhatsApp Oficial (Fase S5.6)
// Fonte única de metadados do canal WhatsApp do Motor Central.
//
// NÃO duplica envio nem altera Raio-X / Z-API.
// =============================================================================

import { config } from "../../../../infra/config.js";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { getChannelDefinition } from "../channels/channelRegistry.js";
import { hasWhatsAppLiveCredentials } from "../providers/abstraction/providerPolicy.js";
import {
  resolveActiveWhatsAppProviderName,
  resolveWhatsAppProviderAdapter,
} from "../providers/whatsapp/whatsappProviderResolver.js";
import { WHATSAPP_PROVIDER_NAMES } from "../providers/whatsapp/whatsappProviderEnv.js";
import { getManualSaleRayxRuntimeEnvSnapshot } from "../sales/manualSaleRayxLiveDelivery.js";
import {
  S7_WHATSAPP_MANUAL_RAYX_API_PATH,
  S7_WHATSAPP_MANUAL_RAYX_FLOW,
  S7_WHATSAPP_OFFICIAL_MODE,
  S7_WHATSAPP_OFFICIAL_PROVIDER,
  S7_WHATSAPP_OFFICIAL_PROVIDER_DEFAULT,
  S7_WHATSAPP_OUTBOX_WORKER_PATH,
  S7_WHATSAPP_PROVIDER_REGISTRY_ORDER,
} from "./whatsappChannelContract.js";
import {
  evaluateWhatsAppSendPolicy,
  getWhatsAppSandboxWhitelist,
  isDevSandboxWhatsAppMode,
} from "./whatsappSandboxPolicy.js";
import { isWhatsAppLiveDeliveryActive } from "./S7WhatsAppProvider.js";
import { S7_WHATSAPP_OUTBOX_STATUS } from "./whatsappOutboxStatus.js";
import { describeWhatsAppMultiRecipientPolicy } from "./whatsappMultiRecipient.js";

/**
 * Snapshot oficial do canal (sem secrets).
 */
export function getOfficialWhatsAppChannelSnapshot() {
  const channelDef = getChannelDefinition(S7_NOTIFICATION_CHANNEL.WHATSAPP);
  const configuredProvider = resolveActiveWhatsAppProviderName();
  const adapterResolution = resolveWhatsAppProviderAdapter();
  const mode = String(config.s7WhatsAppMode ?? S7_WHATSAPP_OFFICIAL_MODE.MOCK).toLowerCase();
  const rayxEnv = getManualSaleRayxRuntimeEnvSnapshot();

  return {
    channel_code: S7_NOTIFICATION_CHANNEL.WHATSAPP,
    channel_registry: channelDef
      ? {
          name: channelDef.name,
          status: channelDef.status,
          available: channelDef.available,
          delivery_mode: channelDef.delivery_mode,
          capabilities: channelDef.capabilities,
        }
      : null,
    official_provider_default: S7_WHATSAPP_OFFICIAL_PROVIDER_DEFAULT,
    configured_provider: configuredProvider,
    effective_delivery_mode: adapterResolution.deliveryMode,
    effective_tier: adapterResolution.tier,
    mode,
    zapi_configured:
      configuredProvider === WHATSAPP_PROVIDER_NAMES.ZAPI && hasWhatsAppLiveCredentials(),
    meta_cloud_registered: S7_WHATSAPP_PROVIDER_REGISTRY_ORDER.includes(
      WHATSAPP_PROVIDER_NAMES.META_CLOUD
    ),
    live_delivery_active: isWhatsAppLiveDeliveryActive(),
    has_live_credentials: hasWhatsAppLiveCredentials(),
    dev_sandbox: isDevSandboxWhatsAppMode(),
    sandbox_whitelist_count: getWhatsAppSandboxWhitelist().length,
    s7_allow_live_delivery: String(config.s7AllowLiveDelivery ?? "false").toLowerCase() === "true",
    outbox_worker_path: S7_WHATSAPP_OUTBOX_WORKER_PATH,
    outbox_statuses: Object.values(S7_WHATSAPP_OUTBOX_STATUS),
    dispatcher_integration: {
      provider_class: "WhatsAppNotificationProvider",
      delivery_provider_key: adapterResolution.configured_provider,
      queue_table: "s7_notification_whatsapp_outbox",
      delivery_logs_table: "s7_notification_delivery_logs",
      dispatch_table: "s7_notification_dispatches",
      engine_entry: "runCentralDispatcher → runNotificationActionsEngine",
    },
    templates_integration: {
      resolve: "resolveNotificationTemplate",
      render: "renderNotificationWhatsAppTemplate / renderNotificationWhatsAppSandboxTemplate",
      registry: "Central de Templates S5.4 (s7_notification_templates)",
    },
    multi_provider: {
      registry_order: [...S7_WHATSAPP_PROVIDER_REGISTRY_ORDER],
      resolver: "resolveWhatsAppProviderAdapter",
      strategy_interface: "WhatsAppProviderStrategy",
      note: "Troca via WHATSAPP_PROVIDER ou S7_WHATSAPP_PROVIDER sem refatorar o motor.",
    },
    multi_recipient: describeWhatsAppMultiRecipientPolicy(),
    manual_sale_rayx: {
      preserved: true,
      api_path: S7_WHATSAPP_MANUAL_RAYX_API_PATH,
      flow: S7_WHATSAPP_MANUAL_RAYX_FLOW.FLOW,
      source_module: S7_WHATSAPP_MANUAL_RAYX_FLOW.SOURCE_MODULE,
      provider_homologated: S7_WHATSAPP_OFFICIAL_PROVIDER.ZAPI,
      runtime: {
        whatsapp_provider: rayxEnv.whatsapp_provider,
        s7_whatsapp_mode: rayxEnv.s7_whatsapp_mode,
        live_delivery_active: rayxEnv.live_delivery_active,
        s7_zapi_base_url_configured: rayxEnv.s7_zapi_base_url_configured,
      },
      pipeline:
        "Modal Raio-X → POST sale-rayx → publishNotificationEvent → Actions Engine → outbox → processWhatsAppOutboxDispatch → Z-API",
    },
  };
}

/**
 * Avalia política de envio para um telefone (wrapper público).
 * @param {string} phoneDigits
 */
export function evaluateOfficialWhatsAppPolicy(phoneDigits) {
  return evaluateWhatsAppSendPolicy(phoneDigits);
}
