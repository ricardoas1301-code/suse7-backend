// =============================================================================
// Regras evento × destinatário × canal (Fase 3.2.2)
// =============================================================================

import { isValidNotificationCategory } from "../constants/categories.js";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { logNotificationPref } from "./sellerNotificationObservability.js";

const RULE_CHANNELS = new Set([S7_NOTIFICATION_CHANNEL.EMAIL, S7_NOTIFICATION_CHANNEL.WHATSAPP]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function listSellerEventDeliveryRules(supabase, sellerId) {
  const { data, error } = await supabase
    .from("s7_notification_event_delivery_rules")
    .select("*")
    .eq("seller_id", sellerId);

  if (error) throw error;
  return { rules: data ?? [] };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} categoryCode
 * @param {string} typeKey
 */
export async function listRulesForEvent(supabase, sellerId, categoryCode, typeKey) {
  const { data, error } = await supabase
    .from("s7_notification_event_delivery_rules")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("category_code", categoryCode)
    .eq("type_key", typeKey);

  if (error) throw error;
  return data ?? [];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Array<{ category_code: string, type_key: string, recipient_group_id: string, channel: string, enabled: boolean }>} updates
 */
export async function patchSellerEventDeliveryRules(supabase, sellerId, updates) {
  const now = new Date().toISOString();

  for (const raw of updates ?? []) {
    const category_code = String(raw.category_code ?? "").trim();
    const type_key = String(raw.type_key ?? "").trim();
    const recipient_group_id = String(raw.recipient_group_id ?? "").trim();
    const channel = String(raw.channel ?? "").trim();
    const enabled = Boolean(raw.enabled);

    if (!isValidNotificationCategory(category_code) || !type_key) {
      return { ok: false, error: "INVALID_EVENT", message: "Evento inválido." };
    }
    if (!RULE_CHANNELS.has(channel)) {
      return { ok: false, error: "INVALID_CHANNEL", message: "Canal inválido para regra." };
    }
    if (!recipient_group_id) {
      return { ok: false, error: "INVALID_GROUP", message: "Destinatário inválido." };
    }

    const { data: existing } = await supabase
      .from("s7_notification_event_delivery_rules")
      .select("id")
      .eq("seller_id", sellerId)
      .eq("category_code", category_code)
      .eq("type_key", type_key)
      .eq("recipient_group_id", recipient_group_id)
      .eq("channel", channel)
      .maybeSingle();

    if (existing?.id) {
      const { error } = await supabase
        .from("s7_notification_event_delivery_rules")
        .update({ enabled, updated_at: now })
        .eq("id", existing.id);
      if (error) throw error;
    } else if (enabled) {
      const { error } = await supabase.from("s7_notification_event_delivery_rules").insert({
        seller_id: sellerId,
        category_code,
        type_key,
        recipient_group_id,
        channel,
        enabled: true,
        created_at: now,
        updated_at: now,
      });
      if (error) throw error;
    }
  }

  logNotificationPref("EVENT_RULES_PATCH_OK", { seller_id: sellerId, count: updates?.length ?? 0 });
  return { ok: true, ...(await listSellerEventDeliveryRules(supabase, sellerId)) };
}
