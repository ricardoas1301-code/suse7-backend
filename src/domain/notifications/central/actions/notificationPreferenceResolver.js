// =============================================================================
// Preferências do seller — wrapper (Fase 3.5C.1.A2)
// =============================================================================

import { resolveNotificationPreferences } from "../preferences/resolveNotificationPreferences.js";
import { logNotificationActions } from "./notificationActionsLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ sellerId: string; category: string; type: string }} input
 */
export async function resolveNotificationActionPreferences(supabase, input) {
  const prefs = await resolveNotificationPreferences(supabase, input);
  logNotificationActions("PREFERENCES_RESOLVED", {
    seller_id: input.sellerId,
    category: input.category,
    type: input.type,
    mandatory: prefs.mandatory,
    enabled_channels: prefs.enabledChannels,
  });
  return prefs;
}
