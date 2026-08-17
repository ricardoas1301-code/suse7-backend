// =============================================================================
// Resolve destinatários do motor central
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
async function loadSellerProfileContact(supabase, sellerId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, phone")
    .eq("id", sellerId)
    .maybeSingle();
  if (error) return null;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   category: string;
 *   type: string;
 *   channel: string;
 *   marketplaceAccountId?: string | null;
 * }} input
 * @returns {Promise<Array<{ recipientId: string | null, destination: string | null, label?: string }>>}
 */
export async function resolveCentralRecipients(supabase, input) {
  const sellerId = String(input.sellerId ?? "").trim();
  const category = String(input.category ?? "").trim();
  const type = String(input.type ?? "").trim();
  const channel = String(input.channel ?? "").trim();
  const marketplaceAccountId =
    input.marketplaceAccountId != null && String(input.marketplaceAccountId).trim() !== ""
      ? String(input.marketplaceAccountId).trim()
      : null;

  if (channel === S7_NOTIFICATION_CHANNEL.IN_APP) {
    return [{ recipientId: null, destination: null, label: "owner_in_app" }];
  }

  const { data: recipients, error } = await supabase
    .from("s7_notification_recipients")
    .select("id, channel, destination, label, marketplace_account_id, recipient_group_id")
    .eq("seller_id", sellerId)
    .eq("channel", channel)
    .eq("is_active", true);

  if (error) throw error;

  /** @type {Array<Record<string, unknown>>} */
  let eventRules = [];
  try {
    const { data: rules, error: rulesErr } = await supabase
      .from("s7_notification_event_delivery_rules")
      .select("recipient_group_id, channel, enabled")
      .eq("seller_id", sellerId)
      .eq("category_code", category)
      .eq("type_key", type);
    if (rulesErr) throw rulesErr;
    eventRules = rules ?? [];
  } catch (rulesErr) {
    const code = rulesErr && typeof rulesErr === "object" ? String(rulesErr.code ?? "") : "";
    if (code !== "42P01") throw rulesErr;
    eventRules = [];
  }

  const hasEventRules = eventRules.length > 0;
  const enabledRulesForChannel = hasEventRules
    ? eventRules.filter((r) => String(r.channel) === channel && r.enabled === true)
    : [];

  const recipientIds = (recipients ?? []).map((r) => r.id).filter(Boolean);
  /** @type {Map<string, Array<{ category_code: string, type_key: string | null, is_active: boolean }>>} */
  const scopesByRecipient = new Map();

  if (recipientIds.length > 0) {
    const { data: scopes, error: scopeErr } = await supabase
      .from("s7_notification_recipient_scopes")
      .select("recipient_id, category_code, type_key, is_active")
      .in("recipient_id", recipientIds)
      .eq("is_active", true);
    if (scopeErr) throw scopeErr;
    for (const s of scopes ?? []) {
      const rid = String(s.recipient_id);
      const list = scopesByRecipient.get(rid) ?? [];
      list.push(s);
      scopesByRecipient.set(rid, list);
    }
  }

  /** @type {Array<{ recipientId: string | null, destination: string | null, label?: string }>} */
  const resolved = [];

  for (const r of recipients ?? []) {
    const dest = r.destination != null ? String(r.destination).trim() : "";
    if (!dest) continue;

    const accountOk =
      !marketplaceAccountId ||
      !r.marketplace_account_id ||
      String(r.marketplace_account_id) === marketplaceAccountId;

    if (!accountOk) continue;

    if (hasEventRules) {
      const groupId =
        r.recipient_group_id != null ? String(r.recipient_group_id) : String(r.id);
      const allowed = enabledRulesForChannel.some(
        (rule) => String(rule.recipient_group_id) === groupId
      );
      if (!allowed) continue;
    } else {
      const scopes = scopesByRecipient.get(String(r.id)) ?? [];
      if (scopes.length > 0) {
        const match = scopes.some((s) => {
          if (!s?.is_active) return false;
          if (String(s.category_code) !== category) return false;
          if (s.type_key != null && String(s.type_key) !== type) return false;
          return true;
        });
        if (!match) continue;
      }
    }

    resolved.push({
      recipientId: r.id != null ? String(r.id) : null,
      destination: dest,
      label: r.label != null ? String(r.label) : undefined,
    });
  }

  if (resolved.length === 0) {
    const profile = await loadSellerProfileContact(supabase, sellerId);
    if (channel === S7_NOTIFICATION_CHANNEL.EMAIL && profile?.email) {
      resolved.push({
        recipientId: null,
        destination: String(profile.email).trim().toLowerCase(),
        label: "profile_fallback",
      });
    }
    if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && profile?.phone) {
      resolved.push({
        recipientId: null,
        destination: String(profile.phone).replace(/\D/g, ""),
        label: "profile_fallback",
      });
    }
  }

  logCentralNotification("RECIPIENTS_RESOLVED", {
    seller_id: sellerId,
    category,
    type,
    channel,
    count: resolved.length,
  });

  return resolved;
}
