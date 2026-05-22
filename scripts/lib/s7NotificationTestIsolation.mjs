// =============================================================================
// Isolamento de dados — suítes 3.2.1 / 3.2.2 (DEV, service role)
// =============================================================================

import { createClient } from "@supabase/supabase-js";

/** Evento exclusivo 3.2.1 — resolver legado por scopes (sem colisão com regras 3.2.2). */
export const SUITE_321_RESOLVER_EVENT = Object.freeze({
  category: "SALES",
  type_key: "ORDER_CANCELLED",
});

/** Escopo do destinatário criado para o teste de resolver 3.2.1. */
export const SUITE_321_RESOLVER_SCOPE = Object.freeze({
  category_code: "SALES",
});

export const SUITE_322_RULES_EVENT = Object.freeze({
  category: "BILLING",
  type_key: "PAYMENT_GENERATED",
});

/** Evento exclusivo 3.3 — inbox in-app (não colide com 3.2.1/3.2.2). */
export const SUITE_33_IN_APP_EVENT = Object.freeze({
  category: "BILLING",
  type_key: "PAYMENT_GENERATED",
});

export const SUITE_33_MANDATORY_EVENT = Object.freeze({
  category: "BILLING",
  type_key: "PAYMENT_FAILED",
});

/** Evento com template e-mail no catálogo 3.1. */
export const SUITE_34_EMAIL_EVENT = Object.freeze({
  category: "BILLING",
  type_key: "PAYMENT_CONFIRMED",
});

/** Regras por destinatário — usa evento com template e-mail no catálogo. */
export const SUITE_34_RULES_EVENT = Object.freeze({
  category: "BILLING",
  type_key: "PAYMENT_CONFIRMED",
});

/** Evento com template WhatsApp no catálogo (Fase 3.5A). */
export const SUITE_35_WHATSAPP_EVENT = Object.freeze({
  category: "BILLING",
  type_key: "PAYMENT_FAILED",
});

export const SUITE_35_RULES_EVENT = Object.freeze({
  category: "BILLING",
  type_key: "PAYMENT_FAILED",
});

/**
 * @param {{ supabaseUrl?: string, serviceKey?: string, anonKey?: string }} env
 */
export function createNotificationTestClients(env) {
  const supabaseUrl = env.supabaseUrl?.trim();
  const serviceKey = env.serviceKey?.trim();
  const anonKey = env.anonKey?.trim() || serviceKey;
  if (!supabaseUrl || !serviceKey) {
    return { sb: null, anonKey };
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  return { sb, anonKey };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} email
 */
export async function resolveSellerIdByEmail(sb, email) {
  const { data, error } = await sb.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const normalized = String(email).toLowerCase();
  return data?.users?.find((u) => String(u.email ?? "").toLowerCase() === normalized)?.id ?? null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} category
 * @param {string} typeKey
 */
export async function purgeEventDeliveryRulesForEvent(sb, sellerId, category, typeKey) {
  const { error } = await sb
    .from("s7_notification_event_delivery_rules")
    .delete()
    .eq("seller_id", sellerId)
    .eq("category_code", category)
    .eq("type_key", typeKey);
  if (error && error.code !== "42P01") throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string[]} destinationSubstrings
 */
export async function purgeRecipientsByDestinationHints(sb, sellerId, destinationSubstrings) {
  const { data, error } = await sb
    .from("s7_notification_recipients")
    .select("id, destination, recipient_group_id")
    .eq("seller_id", sellerId);
  if (error) throw error;

  const hints = destinationSubstrings.map((h) => String(h).toLowerCase());
  const rowIds = [];
  const groupIds = new Set();

  for (const row of data ?? []) {
    const dest = String(row.destination ?? "").toLowerCase();
    if (hints.some((h) => dest.includes(h))) {
      rowIds.push(String(row.id));
      if (row.recipient_group_id) groupIds.add(String(row.recipient_group_id));
    }
  }

  if (rowIds.length > 0) {
    await sb.from("s7_notification_recipient_scopes").delete().in("recipient_id", rowIds);
    await sb.from("s7_notification_recipients").delete().in("id", rowIds);
  }

  for (const gid of groupIds) {
    await sb
      .from("s7_notification_event_delivery_rules")
      .delete()
      .eq("seller_id", sellerId)
      .eq("recipient_group_id", gid);
  }

  return { removedRows: rowIds.length, removedGroups: groupIds.size };
}

/**
 * Prepara ambiente 3.2.1: remove regras do evento usado pelo resolver legado (scopes).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function prepareSuite321Isolation(sb, sellerId, runToken) {
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_321_RESOLVER_EVENT.category,
    SUITE_321_RESOLVER_EVENT.type_key
  );
  await purgeEventDeliveryRulesForEvent(sb, sellerId, "BILLING", "PAYMENT_CONFIRMED");
  await purgeRecipientsByDestinationHints(sb, sellerId, [`phase321.${runToken}`]);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function cleanupSuite321Run(sb, sellerId, runToken) {
  await purgeRecipientsByDestinationHints(sb, sellerId, [`phase321.${runToken}`, `phase321.b.${runToken}`]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_321_RESOLVER_EVENT.category,
    SUITE_321_RESOLVER_EVENT.type_key
  );
  await purgeEventDeliveryRulesForEvent(sb, sellerId, "BILLING", "PAYMENT_CONFIRMED");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function prepareSuite322Isolation(sb, sellerId, runToken) {
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_322_RULES_EVENT.category,
    SUITE_322_RULES_EVENT.type_key
  );
  await purgeRecipientsByDestinationHints(sb, sellerId, [
    `p322.`,
    `p322.${runToken}`,
    `p322.shared.${runToken}`,
  ]);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
/**
 * Remove eventos/dispatches de teste 3.3 por idempotency_key.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function cleanupSuite34Run(sb, sellerId, runToken) {
  const { data: events } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .like("idempotency_key", `p34.${runToken}%`);

  const eventIds = (events ?? []).map((e) => String(e.id));
  if (eventIds.length > 0) {
    const { data: dispatches } = await sb
      .from("s7_notification_dispatches")
      .select("id")
      .in("event_id", eventIds);
    const dispatchIds = (dispatches ?? []).map((d) => String(d.id));
    if (dispatchIds.length > 0) {
      await sb.from("s7_notification_email_outbox").delete().in("dispatch_id", dispatchIds);
    }
    await sb.from("s7_notification_dispatches").delete().in("event_id", eventIds);
    await sb.from("s7_notification_events").delete().in("id", eventIds);
  }

  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_34_RULES_EVENT.category,
    SUITE_34_RULES_EVENT.type_key
  );
  await purgeRecipientsByDestinationHints(sb, sellerId, [`p34.${runToken}`]);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function prepareSuite34Isolation(sb, sellerId, runToken) {
  await cleanupSuite34Run(sb, sellerId, runToken);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_322_RULES_EVENT.category,
    SUITE_322_RULES_EVENT.type_key
  );
}

export async function cleanupSuite33Run(sb, sellerId, runToken) {
  const { data: events, error } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .like("idempotency_key", `p33.${runToken}%`);
  if (error && error.code !== "42P01") throw error;

  const eventIds = (events ?? []).map((e) => String(e.id));
  if (eventIds.length > 0) {
    await sb.from("s7_notification_dispatches").delete().in("event_id", eventIds);
    await sb.from("s7_notification_events").delete().in("id", eventIds);
  }

  await sb
    .from("s7_notification_preferences")
    .delete()
    .eq("seller_id", sellerId)
    .eq("category_code", SUITE_33_MANDATORY_EVENT.category)
    .eq("type_key", SUITE_33_MANDATORY_EVENT.type_key)
    .eq("channel", "in_app");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function prepareSuite33Isolation(sb, sellerId, runToken) {
  await cleanupSuite33Run(sb, sellerId, runToken);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function cleanupSuite35Run(sb, sellerId, runToken) {
  const { data: events } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .like("idempotency_key", `p35.${runToken}%`);

  const eventIds = (events ?? []).map((e) => String(e.id));
  if (eventIds.length > 0) {
    const { data: dispatches } = await sb
      .from("s7_notification_dispatches")
      .select("id")
      .in("event_id", eventIds);
    const dispatchIds = (dispatches ?? []).map((d) => String(d.id));
    if (dispatchIds.length > 0) {
      const { error: waErr } = await sb
        .from("s7_notification_whatsapp_outbox")
        .delete()
        .in("dispatch_id", dispatchIds);
      if (waErr && waErr.code !== "42P01" && waErr.code !== "PGRST205") throw waErr;
    }
    await sb.from("s7_notification_dispatches").delete().in("event_id", eventIds);
    await sb.from("s7_notification_events").delete().in("id", eventIds);
  }

  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_RULES_EVENT.category,
    SUITE_35_RULES_EVENT.type_key
  );
  await purgeRecipientsByDestinationHints(sb, sellerId, [`p35.${runToken}`]);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function prepareSuite35Isolation(sb, sellerId, runToken) {
  await cleanupSuite35Run(sb, sellerId, runToken);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_RULES_EVENT.category,
    SUITE_35_RULES_EVENT.type_key
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
export async function cleanupSuite35bRun(sb, sellerId, runToken) {
  const { data: events } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .like("idempotency_key", `p35b.${runToken}%`);

  const eventIds = (events ?? []).map((e) => String(e.id));
  if (eventIds.length > 0) {
    const { data: dispatches } = await sb
      .from("s7_notification_dispatches")
      .select("id")
      .in("event_id", eventIds);
    const dispatchIds = (dispatches ?? []).map((d) => String(d.id));
    if (dispatchIds.length > 0) {
      const { error: waErr } = await sb
        .from("s7_notification_whatsapp_outbox")
        .delete()
        .in("dispatch_id", dispatchIds);
      if (waErr && waErr.code !== "42P01" && waErr.code !== "PGRST205") throw waErr;
    }
    await sb.from("s7_notification_dispatches").delete().in("event_id", eventIds);
    await sb.from("s7_notification_events").delete().in("id", eventIds);
  }

  await purgeRecipientsByDestinationHints(sb, sellerId, [`p35b.${runToken}`]);
}

export async function prepareSuite35bIsolation(sb, sellerId, runToken) {
  await cleanupSuite35bRun(sb, sellerId, runToken);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_WHATSAPP_EVENT.category,
    SUITE_35_WHATSAPP_EVENT.type_key
  );
  await purgeRecipientsByDestinationHints(sb, sellerId, [
    "5511999999999",
    `p35b.${runToken}`,
    `p35b ${runToken}`,
  ]);
}

export async function cleanupSuite322Run(sb, sellerId, runToken) {
  await purgeRecipientsByDestinationHints(sb, sellerId, [
    `p322.${runToken}`,
    `p322.shared.${runToken}`,
    `p322.a.${runToken}`,
    `p322.wa.${runToken}`,
    `p322.wb.${runToken}`,
    `p322.b.`,
  ]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_322_RULES_EVENT.category,
    SUITE_322_RULES_EVENT.type_key
  );
}
