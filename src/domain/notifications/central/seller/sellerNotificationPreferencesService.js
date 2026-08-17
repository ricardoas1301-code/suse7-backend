// =============================================================================
// Preferências seller — GET / PATCH (Fase 3.1.1)
// =============================================================================

import {
  S7_NOTIFICATION_CHANNEL,
  S7_NOTIFICATION_CHANNEL_ORDER,
  isValidNotificationChannel,
} from "../constants/channels.js";
import { isValidNotificationCategory } from "../constants/categories.js";
import { logNotificationPref } from "./sellerNotificationObservability.js";
import { validatePreferencePatches } from "./validateMandatoryPreferences.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
async function loadPreferenceRows(supabase, sellerId) {
  const { data, error } = await supabase
    .from("s7_notification_preferences")
    .select("id, category_code, type_key, channel, enabled, updated_at")
    .eq("seller_id", sellerId);
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function loadEventTypes(supabase) {
  const { data, error } = await supabase
    .from("s7_notification_event_types")
    .select("category_code, type_key, is_mandatory, default_channels, supported_channels")
    .eq("is_active", true);
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {Array<Record<string, unknown>>} types
 * @param {Array<Record<string, unknown>>} prefRows
 */
function buildPreferencesMatrix(types, prefRows) {
  /** @type {Record<string, boolean>} */
  const prefLookup = {};
  for (const row of prefRows) {
    const tk = row.type_key != null ? String(row.type_key) : "*";
    prefLookup[`${row.category_code}:${tk}:${row.channel}`] = Boolean(row.enabled);
  }

  /** @type {Array<Record<string, unknown>>} */
  const items = [];

  for (const t of types) {
    const category = String(t.category_code);
    const typeKey = String(t.type_key);
    const mandatory = Boolean(t.is_mandatory);
    const supported = Array.isArray(t.supported_channels)
      ? t.supported_channels.map(String)
      : S7_NOTIFICATION_CHANNEL_ORDER;
    const defaults = Array.isArray(t.default_channels) ? t.default_channels.map(String) : [];

    /** @type {Record<string, { enabled: boolean, locked: boolean }>} */
    const channels = {};

    for (const ch of S7_NOTIFICATION_CHANNEL_ORDER) {
      if (!supported.includes(ch)) continue;
      if (ch !== S7_NOTIFICATION_CHANNEL.IN_APP) continue;

      const specific = prefLookup[`${category}:${typeKey}:${ch}`];
      const categoryWide = prefLookup[`${category}:*:${ch}`];
      const enabled =
        specific !== undefined
          ? specific
          : categoryWide !== undefined
            ? categoryWide
            : defaults.includes(ch) || true;

      channels[ch] = {
        enabled,
        locked: mandatory && ch === S7_NOTIFICATION_CHANNEL.IN_APP,
      };
    }

    items.push({
      category_code: category,
      type_key: typeKey,
      is_mandatory: mandatory,
      channels,
    });
  }

  return items;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function getSellerNotificationPreferences(supabase, sellerId) {
  const [types, prefRows] = await Promise.all([loadEventTypes(supabase), loadPreferenceRows(supabase, sellerId)]);
  const preferences = buildPreferencesMatrix(types, prefRows);

  logNotificationPref("GET_OK", { seller_id: sellerId, items: preferences.length });

  return {
    seller_id: sellerId,
    preferences,
    updated_at: prefRows.length
      ? prefRows.reduce((max, r) => {
          const t = r.updated_at ? new Date(String(r.updated_at)).getTime() : 0;
          return t > max ? t : max;
        }, 0)
      : null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Array<{ category_code: string, type_key?: string | null, channel: string, enabled: boolean }>} updates
 */
export async function patchSellerNotificationPreferences(supabase, sellerId, updates) {
  const types = await loadEventTypes(supabase);
  const typeLookup = new Map(types.map((t) => [`${t.category_code}:${t.type_key}`, t]));

  const normalized = [];
  for (const raw of updates ?? []) {
    const category_code = String(raw.category_code ?? "").trim();
    const type_key = raw.type_key != null && String(raw.type_key).trim() !== "" ? String(raw.type_key).trim() : null;
    const channel = String(raw.channel ?? "").trim();

    if (!isValidNotificationCategory(category_code)) {
      return { ok: false, error: "INVALID_CATEGORY", message: `Categoria inválida: ${category_code}` };
    }
    if (!isValidNotificationChannel(channel)) {
      return { ok: false, error: "INVALID_CHANNEL", message: `Canal inválido: ${channel}` };
    }
    if (channel === S7_NOTIFICATION_CHANNEL.PUSH) {
      return { ok: false, error: "CHANNEL_NOT_AVAILABLE", message: "Canal pop-up ainda não disponível." };
    }
    if (channel === S7_NOTIFICATION_CHANNEL.EMAIL || channel === S7_NOTIFICATION_CHANNEL.WHATSAPP) {
      return {
        ok: false,
        error: "CHANNEL_MANAGED_BY_RECIPIENTS",
        message: "E-mail e WhatsApp são configurados por destinatário em cada evento.",
      };
    }

    if (type_key) {
      const meta = typeLookup.get(`${category_code}:${type_key}`);
      if (!meta) {
        return { ok: false, error: "INVALID_TYPE", message: `Tipo inválido: ${type_key}` };
      }
      normalized.push({
        category_code,
        type_key,
        channel,
        enabled: Boolean(raw.enabled),
        is_mandatory: Boolean(meta.is_mandatory),
      });
    } else {
      normalized.push({
        category_code,
        type_key: null,
        channel,
        enabled: Boolean(raw.enabled),
        is_mandatory: false,
      });
    }
  }

  const current = await getSellerNotificationPreferences(supabase, sellerId);
  const flatRows = [];
  for (const item of current.preferences) {
    for (const [ch, st] of Object.entries(item.channels ?? {})) {
      flatRows.push({
        category_code: item.category_code,
        type_key: item.type_key,
        channel: ch,
        enabled: st.enabled,
        is_mandatory: item.is_mandatory,
      });
    }
  }

  const validation = validatePreferencePatches(flatRows, normalized);
  if (!validation.ok) {
    return { ok: false, error: validation.code, message: validation.message };
  }

  const now = new Date().toISOString();
  for (const row of normalized) {
    let q = supabase
      .from("s7_notification_preferences")
      .select("id")
      .eq("seller_id", sellerId)
      .eq("category_code", row.category_code)
      .eq("channel", row.channel);

    q = row.type_key
      ? q.eq("type_key", row.type_key)
      : q.is("type_key", null);

    const { data: existing, error: findErr } = await q.maybeSingle();
    if (findErr) throw findErr;

    if (existing?.id) {
      const { error } = await supabase
        .from("s7_notification_preferences")
        .update({ enabled: row.enabled, updated_at: now })
        .eq("id", existing.id)
        .eq("seller_id", sellerId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("s7_notification_preferences").insert({
        seller_id: sellerId,
        category_code: row.category_code,
        type_key: row.type_key,
        channel: row.channel,
        enabled: row.enabled,
        updated_at: now,
        created_at: now,
      });
      if (error) throw error;
    }
  }

  logNotificationPref("PATCH_OK", { seller_id: sellerId, count: normalized.length });

  const refreshed = await getSellerNotificationPreferences(supabase, sellerId);
  return { ok: true, ...refreshed };
}
