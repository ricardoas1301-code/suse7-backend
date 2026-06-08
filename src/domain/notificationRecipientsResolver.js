// ============================================================
// Resolver de destinatários — usado por API/workers (Fase 1)
// resolveNotificationRecipients({ userId, notificationType, marketplaceAccountId, channel })
// ============================================================

import {
  NOTIFICATION_ROUTING_CHANNELS,
  NOTIFICATION_ROUTING_TYPE_LOOKUP,
  isValidRoutingChannel,
  isValidRoutingNotificationType,
} from "./notificationRoutingCatalog.js";

/**
 * Filtra regras ativas compatíveis com o marketplace alvo (match explícito ou fallback NULL).
 * @param {Array<Record<string, unknown>>} rules
 * @param {string|null|undefined} marketplaceAccountId
 */
function filterRulesForMarketplace(rules, marketplaceAccountId) {
  const mid = marketplaceAccountId != null ? String(marketplaceAccountId).trim() : "";
  return rules.filter((r) => {
    const ra = r.marketplace_account_id != null ? String(r.marketplace_account_id).trim() : "";
    if (!mid) return true;
    if (!ra) return true;
    return ra === mid;
  });
}

/**
 * Contato deve possuir canal solicitado (whatsapp ou email preenchidos no cadastro).
 */
function contactSupportsChannel(contact, channel) {
  if (channel === NOTIFICATION_ROUTING_CHANNELS.whatsapp) {
    return Boolean(contact?.whatsapp && String(contact.whatsapp).trim());
  }
  if (channel === NOTIFICATION_ROUTING_CHANNELS.email) {
    return Boolean(contact?.email && String(contact.email).trim());
  }
  return true;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string,
 *   notificationType: string,
 *   marketplaceAccountId?: string|null,
 *   channel: string,
 * }} params
 */
export async function resolveNotificationRecipients(supabase, params) {
  const userId = params?.userId != null ? String(params.userId).trim() : "";
  const notificationType = params?.notificationType != null ? String(params.notificationType).trim() : "";
  const marketplaceAccountId =
    params?.marketplaceAccountId != null && String(params.marketplaceAccountId).trim() !== ""
      ? String(params.marketplaceAccountId).trim()
      : null;
  const channel = params?.channel != null ? String(params.channel).trim() : "";

  const catalogEntry = NOTIFICATION_ROUTING_TYPE_LOOKUP[notificationType] ?? null;

  const empty = {
    ok: true,
    user_id: userId || null,
    notification_type: notificationType || null,
    marketplace_account_id: marketplaceAccountId,
    channel,
    catalog: catalogEntry,
    rules_active: [],
    contacts_resolved: [],
    owner_app: false,
  };

  if (!userId || !isValidRoutingNotificationType(notificationType) || !isValidRoutingChannel(channel)) {
    return { ...empty, ok: false, error: "INVALID_PARAMS" };
  }

  const { data: ruleRows, error: ruleErr } = await supabase
    .from("notification_routing_rules")
    .select("id, user_id, notification_type, notification_channel, contact_id, marketplace_account_id, active")
    .eq("user_id", userId)
    .eq("notification_type", notificationType)
    .eq("notification_channel", channel)
    .eq("active", true);

  if (ruleErr) {
    console.error("[notificationRecipientsResolver] rules query", ruleErr);
    return { ...empty, ok: false, error: "DB_ERROR" };
  }

  const rules = Array.isArray(ruleRows) ? ruleRows : [];
  const scoped = filterRulesForMarketplace(rules, marketplaceAccountId);

  if (channel === NOTIFICATION_ROUTING_CHANNELS.app) {
    const ownerSignals = scoped.some((r) => r.contact_id == null);
    return {
      ...empty,
      rules_active: scoped,
      owner_app: ownerSignals || scoped.length === 0,
    };
  }

  const contactIds = [
    ...new Set(scoped.map((r) => r.contact_id).filter((id) => id != null && String(id).trim() !== "")),
  ];

  if (contactIds.length === 0) {
    return {
      ...empty,
      rules_active: scoped,
      contacts_resolved: [],
    };
  }

  const { data: contactRows, error: contactErr } = await supabase
    .from("notification_contacts")
    .select("id, user_id, name, role, whatsapp, email, active")
    .eq("user_id", userId)
    .eq("active", true)
    .in("id", contactIds);

  if (contactErr) {
    console.error("[notificationRecipientsResolver] contacts query", contactErr);
    return { ...empty, ok: false, error: "DB_ERROR" };
  }

  const contactsRaw = Array.isArray(contactRows) ? contactRows : [];
  const contactsResolved = contactsRaw
    .filter((c) => contactSupportsChannel(c, channel))
    .map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      whatsapp: channel === NOTIFICATION_ROUTING_CHANNELS.whatsapp ? c.whatsapp : null,
      email: channel === NOTIFICATION_ROUTING_CHANNELS.email ? c.email : null,
    }));

  return {
    ...empty,
    rules_active: scoped,
    contacts_resolved: contactsResolved,
  };
}
