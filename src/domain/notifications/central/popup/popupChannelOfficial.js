// =============================================================================
// S7 — Canal Pop-up Oficial (Fase S5.7)
// Fonte única de metadados do canal Pop-up do Motor Central.
// NÃO altera UX atual (toasts legados, AlertasPopup de preferências, billing popup).
// =============================================================================

import { getChannelDefinition, isRegisteredChannel } from "../channels/channelRegistry.js";
import {
  S7_POPUP_CHANNEL_CODE,
  S7_POPUP_DELIVERIES_TABLE,
  S7_POPUP_DISPLAY_MODE,
  S7_POPUP_DISPLAY_TYPE,
  S7_POPUP_OFFICIAL_PROVIDER,
  S7_POPUP_UI_SURFACE,
} from "./popupChannelContract.js";
import { describePopupMultiSurfaceReuse } from "./popupUiReuse.js";
import { planPopupDisplay } from "./popupDisplayPolicy.js";

/**
 * Snapshot oficial do canal (sem secrets, sem eventos).
 */
export function getOfficialPopupChannelSnapshot() {
  const channelDef = getChannelDefinition(S7_POPUP_CHANNEL_CODE);

  return {
    channel_code: S7_POPUP_CHANNEL_CODE,
    channel_registry: channelDef
      ? {
          name: channelDef.name,
          status: channelDef.status,
          available: channelDef.available,
          supported: channelDef.supported,
          delivery_mode: channelDef.delivery_mode,
          type: channelDef.type,
          capabilities: channelDef.capabilities,
        }
      : null,
    official_provider: S7_POPUP_OFFICIAL_PROVIDER,
    registered: isRegisteredChannel(S7_POPUP_CHANNEL_CODE),
    delivery_active: channelDef?.available === true,
    display_types: Object.values(S7_POPUP_DISPLAY_TYPE),
    display_modes: Object.values(S7_POPUP_DISPLAY_MODE),
    ui_surfaces: Object.values(S7_POPUP_UI_SURFACE),
    persistence: {
      table: S7_POPUP_DELIVERIES_TABLE,
      supports_expiration: true,
      supports_persist_until: true,
      supports_read_and_dismiss: true,
    },
    dispatcher_integration: {
      provider_registered: false,
      note: "Provider de entrega será registrado quando canal.available=true; hoje filtrado pelo Registro + channelResolver.",
      engine_entry: "runCentralDispatcher → runNotificationActionsEngine",
      dispatch_table: "s7_notification_dispatches",
      delivery_logs_table: "s7_notification_delivery_logs",
    },
    templates_integration: {
      registry: "Central de Templates S5.4 (s7_notification_templates)",
      resolve: "resolveNotificationTemplate",
      render: "renderNotificationTemplate",
      preview_popup: "previewPopupTemplate",
      channel_code: S7_POPUP_CHANNEL_CODE,
      versioning_table: "s7_notification_template_versions",
    },
    display_policy: {
      planner: "planPopupDisplay",
      default_immediate: true,
    },
    ui_reuse: describePopupMultiSurfaceReuse(),
    legacy_systems: {
      notification_toast: {
        component: "NotificationToast.jsx",
        context: "NotificationContext",
        note: "Toast in-app legado — reaproveitável como superfície visual; não substituído nesta fase.",
      },
      alertas_popup_prefs: {
        page: "AlertasPopup.jsx",
        keys: "popup_alert.* (user preferences)",
        note: "Preferências de alertas internos — separado do Motor Central.",
      },
      billing_renewal_popup: {
        note: "Popup de renovação billing — domínio billing, não Motor Central.",
      },
    },
    future_compat: {
      desktop: true,
      mobile: true,
      layouts: ["toast", "modal", "banner_inline"],
      providers: ["s7_popup_in_app"],
    },
  };
}

/**
 * @param {Parameters<typeof planPopupDisplay>[0]} input
 */
export function evaluateOfficialPopupDisplay(input) {
  return planPopupDisplay(input);
}
