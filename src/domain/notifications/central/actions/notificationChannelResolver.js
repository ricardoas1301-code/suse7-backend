// =============================================================================

// Canais habilitados para o evento — Fase 3.5C.1.A2

// =============================================================================



import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";

import { lookupNotificationTypeCatalog } from "../constants/eventTypes.js";

import { filterRegisteredAvailableChannels } from "../channels/channelRegistry.js";

import { resolveNotificationActionPreferences } from "./notificationPreferenceResolver.js";

import { logNotificationActions } from "./notificationActionsLog.js";



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {{ sellerId: string; category: string; type: string }} input

 * @returns {Promise<{ channels: string[]; catalog: ReturnType<typeof lookupNotificationTypeCatalog>; prefs: Awaited<ReturnType<typeof resolveNotificationActionPreferences>> }>}

 */

export async function resolveNotificationChannels(supabase, input) {

  const category = String(input.category ?? "").trim();

  const type = String(input.type ?? "").trim();

  const catalog = lookupNotificationTypeCatalog(category, type);

  const prefs = await resolveNotificationActionPreferences(supabase, input);



  const supportedExternal = new Set(

    Array.isArray(catalog?.supportedChannels)

      ? catalog.supportedChannels.map(String)

      : [S7_NOTIFICATION_CHANNEL.EMAIL, S7_NOTIFICATION_CHANNEL.WHATSAPP]

  );



  /** @type {string[]} */

  const candidateChannels = [];

  if (prefs.enabledChannels.includes(S7_NOTIFICATION_CHANNEL.IN_APP)) {

    candidateChannels.push(S7_NOTIFICATION_CHANNEL.IN_APP);

  }

  for (const ch of [S7_NOTIFICATION_CHANNEL.EMAIL, S7_NOTIFICATION_CHANNEL.WHATSAPP]) {

    if (supportedExternal.has(ch)) candidateChannels.push(ch);

  }



  // S5.3: governança — o Dispatcher só consome canais do Registro Oficial e

  // disponíveis. Elimina dependências implícitas de canal.

  const { allowed: channels, rejected } = filterRegisteredAvailableChannels(candidateChannels);



  logNotificationActions("CHANNELS_RESOLVED", {

    seller_id: input.sellerId,

    category,

    type,

    channels,

    rejected_unregistered: rejected.length > 0 ? rejected : undefined,

  });



  return { channels, catalog, prefs };

}


