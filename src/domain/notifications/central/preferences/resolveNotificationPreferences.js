// =============================================================================
// Resolve preferências — seller × categoria × tipo × canal
// =============================================================================

import { S7_NOTIFICATION_CHANNEL, S7_NOTIFICATION_CHANNEL_ORDER } from "../constants/channels.js";
import { lookupNotificationTypeCatalog } from "../constants/eventTypes.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} categoryCode
 * @param {string} typeKey
 */
async function loadPreferenceRows(supabase, sellerId, categoryCode, typeKey) {
  const { data: typeSpecific, error: err1 } = await supabase
    .from("s7_notification_preferences")
    .select("channel, enabled, type_key")
    .eq("seller_id", sellerId)
    .eq("category_code", categoryCode)
    .eq("type_key", typeKey);

  if (err1) throw err1;

  const { data: categoryWide, error: err2 } = await supabase
    .from("s7_notification_preferences")
    .select("channel, enabled, type_key")
    .eq("seller_id", sellerId)
    .eq("category_code", categoryCode)
    .is("type_key", null);

  if (err2) throw err2;

  return [...(categoryWide ?? []), ...(typeSpecific ?? [])];
}

/**
 * Defaults quando seller não configurou preferências.
 * @param {boolean} mandatory
 */
function defaultChannelPrefs(mandatory) {
  return {
    [S7_NOTIFICATION_CHANNEL.IN_APP]: true,
    [S7_NOTIFICATION_CHANNEL.EMAIL]: mandatory ? true : true,
    [S7_NOTIFICATION_CHANNEL.WHATSAPP]: mandatory,
    [S7_NOTIFICATION_CHANNEL.PUSH]: false,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   category: string;
 *   type: string;
 * }} input
 * @returns {Promise<{ channels: Record<string, boolean>, mandatory: boolean }>}
 */
export async function resolveNotificationPreferences(supabase, input) {
  const sellerId = String(input.sellerId ?? "").trim();
  const category = String(input.category ?? "").trim();
  const type = String(input.type ?? "").trim();
  const catalog = lookupNotificationTypeCatalog(category, type);
  const mandatory = Boolean(catalog?.mandatory);

  const prefs = defaultChannelPrefs(mandatory);
  const rows = await loadPreferenceRows(supabase, sellerId, category, type);

  for (const row of rows) {
    const ch = row.channel != null ? String(row.channel) : "";
    if (!ch) continue;
    const isTypeSpecific = row.type_key != null && String(row.type_key) === type;
    const isCategoryWide = row.type_key == null;
    if (!isTypeSpecific && !isCategoryWide) continue;
    prefs[ch] = Boolean(row.enabled);
  }

  if (mandatory) {
    prefs[S7_NOTIFICATION_CHANNEL.IN_APP] = true;
    if (!prefs[S7_NOTIFICATION_CHANNEL.EMAIL] && !prefs[S7_NOTIFICATION_CHANNEL.WHATSAPP]) {
      prefs[S7_NOTIFICATION_CHANNEL.EMAIL] = true;
    }
  }

  /** @type {string[]} */
  const enabledChannels = S7_NOTIFICATION_CHANNEL_ORDER.filter((ch) => prefs[ch] === true);

  logCentralNotification("PREFERENCES_RESOLVED", {
    seller_id: sellerId,
    category,
    type,
    mandatory,
    enabled_channels: enabledChannels,
  });

  return { channels: prefs, mandatory, enabledChannels };
}
