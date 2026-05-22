// ============================================================
// Lê toggles notify.<LEGACY_TYPE> em user_preferences (Fase 2)
// Mesma semântica usada pelo frontend em Notificacoes.jsx (fallback defaults).
// ============================================================

import { getPrimaryLegacyPrefKeyForRouting } from "../notificationRoutingCatalog.js";

const NOTIFY_APP = "app";
const NOTIFY_EMAIL = "email";
const NOTIFY_WHATSAPP = "whatsapp";

function toBool(val, defaultValue = true) {
  if (typeof val === "boolean") return val;
  return defaultValue;
}

function resolveChannelsFromPrefRow(raw) {
  const defaults = {
    [NOTIFY_APP]: true,
    [NOTIFY_EMAIL]: true,
    [NOTIFY_WHATSAPP]: true,
  };

  if (!raw || typeof raw !== "object") return defaults;

  const channels = raw.channels ?? {};
  return {
    [NOTIFY_APP]: toBool(
      raw.channel_app_enabled ?? channels?.[NOTIFY_APP]?.enabled,
      defaults[NOTIFY_APP]
    ),
    [NOTIFY_EMAIL]: toBool(
      raw.channel_email_enabled ?? channels?.[NOTIFY_EMAIL]?.enabled,
      defaults[NOTIFY_EMAIL]
    ),
    [NOTIFY_WHATSAPP]: toBool(
      raw.channel_whatsapp_enabled ?? channels?.[NOTIFY_WHATSAPP]?.enabled,
      defaults[NOTIFY_WHATSAPP]
    ),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} routingNotificationType
 * @returns {Promise<{ app: boolean, email: boolean, whatsapp: boolean }>}
 */
export async function fetchUserNotifyChannelsForRoutingType(supabase, userId, routingNotificationType) {
  const legacy = getPrimaryLegacyPrefKeyForRouting(routingNotificationType);
  const defaults = { app: true, email: true, whatsapp: true };

  if (!legacy) {
    return defaults;
  }

  const key = `notify.${legacy}`;
  const { data, error } = await supabase
    .from("user_preferences")
    .select("value")
    .eq("user_id", userId)
    .eq("key", key)
    .maybeSingle();

  if (error || !data?.value) {
    return defaults;
  }

  return resolveChannelsFromPrefRow(data.value);
}
