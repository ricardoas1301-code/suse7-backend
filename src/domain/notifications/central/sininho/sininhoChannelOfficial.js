// =============================================================================
// S7 — Central Sininho Oficial (Fase S5.8)
// Fonte única de metadados do canal in_app do Motor Central.
// NÃO altera fluxo do sininho, inbox API nem InAppNotificationProvider.
// =============================================================================

import { getChannelDefinition, isRegisteredChannel } from "../channels/channelRegistry.js";
import {
  S7_SININHO_CHANNEL_ALIASES,
  S7_SININHO_CHANNEL_CODE,
  S7_SININHO_FUTURE_CATEGORY,
  S7_SININHO_INBOX_API,
  S7_SININHO_INBOX_TABLE,
  S7_SININHO_OFFICIAL_PROVIDER,
  S7_SININHO_READ_STATE,
  S7_SININHO_SEVERITY,
} from "./sininhoChannelContract.js";
import { buildSininhoTimelineEntry } from "./sininhoHistoryPolicy.js";
import { describeSininhoUiReuse } from "./sininhoUiReuse.js";

/**
 * Snapshot oficial do canal (sem secrets, sem eventos).
 */
export function getOfficialSininhoChannelSnapshot() {
  const channelDef = getChannelDefinition(S7_SININHO_CHANNEL_CODE);

  return {
    channel_code: S7_SININHO_CHANNEL_CODE,
    display_name: "Central Sininho",
    channel_aliases: [...S7_SININHO_CHANNEL_ALIASES],
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
    official_provider: S7_SININHO_OFFICIAL_PROVIDER,
    registered: isRegisteredChannel(S7_SININHO_CHANNEL_CODE),
    delivery_active: channelDef?.available === true,
    severities: Object.values(S7_SININHO_SEVERITY),
    read_states: Object.values(S7_SININHO_READ_STATE),
    persistence: {
      primary_table: S7_SININHO_INBOX_TABLE,
      channel_filter: S7_SININHO_CHANNEL_CODE,
      inbox_columns: [
        "category_code",
        "type_key",
        "title",
        "message",
        "severity",
        "is_read",
        "read_at",
        "deep_link",
        "archived_at",
      ],
      metadata_mirror: "metadata.inbox",
      migration_phase33: "20260522180000_s7_notification_in_app_phase33.sql",
      migration_phase58: "20260603160000_s7_sininho_channel_central_phase58.sql",
    },
    history: {
      list_service: "listSellerNotificationInbox",
      mark_read_service: "markSellerInboxItemRead",
      mark_all_read_service: "markAllSellerInboxRead",
      timeline_builder: "buildSininhoTimelineEntry",
      supports_cursor_pagination: true,
      supports_unread_filter: true,
      archive_prepared: true,
      archive_implemented: false,
    },
    deep_links: {
      resolver: "resolveInAppDeepLink",
      seller_first: true,
    },
    dispatcher_integration: {
      provider_class: "InAppNotificationProvider",
      provider_registered: true,
      delivery_mode: "immediate",
      engine_entry: "runCentralDispatcher → runNotificationActionsEngine",
      dispatch_table: S7_SININHO_INBOX_TABLE,
      delivery_logs_table: "s7_notification_delivery_logs",
      events_table: "s7_notification_events",
    },
    templates_integration: {
      registry: "Central de Templates S5.4 (s7_notification_templates)",
      resolve: "resolveNotificationTemplate",
      render: "renderNotificationTemplate",
      preview_sininho: "previewSininhoTemplate",
      channel_code: S7_SININHO_CHANNEL_CODE,
      versioning_table: "s7_notification_template_versions",
    },
    seller_api: S7_SININHO_INBOX_API,
    ui_reuse: describeSininhoUiReuse(),
    legacy_systems: {
      notification_context_toast: {
        note: "NotificationContext / toasts — paralelo visual, não inbox.",
      },
      central_notificacoes_hub: {
        route: "/perfil/notificacoes",
        note: "Preferências e destinatários — não lista inbox.",
      },
    },
    future_compat: {
      categories: Object.values(S7_SININHO_FUTURE_CATEGORY),
      operational: true,
      financial: true,
      marketplace: true,
      administrative: true,
      preferences_integration: "seller notification preferences (in_app channel)",
    },
  };
}

/**
 * @param {Parameters<typeof buildSininhoTimelineEntry>[0]} input
 */
export function evaluateOfficialSininhoTimeline(input) {
  return buildSininhoTimelineEntry(input);
}
