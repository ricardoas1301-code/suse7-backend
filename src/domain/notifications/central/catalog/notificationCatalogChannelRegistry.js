// =============================================================================
// S7 — Catálogo (S5.11) — registro de canais (Registro Oficial S5.3)
// =============================================================================

import {
  listRegisteredChannels,
  getChannelDefinition,
} from "../channels/channelRegistry.js";
import { S7_NOTIFICATION_CATALOG_CHANNEL } from "./notificationCatalogContract.js";

const CATALOG_CHANNEL_CODES = Object.values(S7_NOTIFICATION_CATALOG_CHANNEL);

/**
 * @returns {Array<{ code: string; name: string; supported: boolean; available: boolean; catalog_eligible: boolean }>}
 */
export function listCatalogSupportedChannels() {
  const registered = new Set(listRegisteredChannels().map((c) => c.code));

  return CATALOG_CHANNEL_CODES.map((code) => {
    const def = getChannelDefinition(code);
    return {
      code,
      name: def?.name ?? code,
      supported: def?.supported === true,
      available: def?.available === true,
      catalog_eligible: registered.has(code),
      delivery_mode: def?.delivery_mode ?? null,
    };
  });
}
