// =============================================================================
// Destinatário padrão — empresa principal (bootstrap idempotente + sync SSOT)
// =============================================================================

import { randomUUID } from "node:crypto";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { isCategoryVisibleToSeller } from "../seller/sellerNotificationUiCatalog.js";
import {
  normalizeAndValidateRecipientDestination,
  findDuplicateRecipientSlot,
} from "../seller/sellerNotificationRecipientValidation.js";
import { logNotificationRecipient } from "../seller/sellerNotificationObservability.js";
import {
  S7_RECIPIENT_KIND,
  hasBootstrapPreferencesCompleted,
  isPrimaryCompanyRecipientRow,
  isRecipientLabelCustomized,
  mergeRecipientMetadata,
} from "./defaultRecipientPolicy.js";

const PRIMARY_COMPANY_SELECT_VARIANTS = [
  "id, user_id, company_name, trade_name, contact_email, whatsapp, is_primary, active, created_at",
  "id, user_id, company_name, trade_name, whatsapp, is_primary, active, created_at",
];

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
async function loadSellerProfileContact(supabase, sellerId) {
  const variants = ["id, email, phone", "id, email"];
  for (const sel of variants) {
    const { data, error } = await supabase.from("profiles").select(sel).eq("id", sellerId).maybeSingle();
    if (!error) {
      return {
        email: data?.email != null ? String(data.email).trim().toLowerCase() : null,
        phone: data?.phone != null ? String(data.phone).replace(/\D/g, "") : null,
      };
    }
    const shapeIssue =
      String(error?.code ?? "") === "42703" || String(error?.message ?? "").toLowerCase().includes("column");
    if (!shapeIssue) throw error;
  }
  return { email: null, phone: null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function loadPrimarySellerCompany(supabase, sellerId) {
  for (const selectExpr of PRIMARY_COMPANY_SELECT_VARIANTS) {
    const hasPrimaryCol = selectExpr.includes("is_primary");
    let q = supabase.from("seller_companies").select(selectExpr).eq("user_id", sellerId);
    if (hasPrimaryCol) {
      q = q.order("is_primary", { ascending: false });
    }
    q = q.order("created_at", { ascending: false }).limit(1);
    const { data, error } = await q.maybeSingle();
    if (!error) return data;
    const shapeIssue =
      String(error?.code ?? "") === "42703" || String(error?.message ?? "").toLowerCase().includes("column");
    if (!shapeIssue) throw error;
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} company
 * @param {{ email?: string | null, phone?: string | null }} profile
 */
export function resolvePrimaryCompanyContactSources(company, profile) {
  const tradeName =
    company?.trade_name != null && String(company.trade_name).trim() !== ""
      ? String(company.trade_name).trim()
      : company?.company_name != null && String(company.company_name).trim() !== ""
        ? String(company.company_name).trim()
        : null;

  const companyEmail =
    company?.contact_email != null && String(company.contact_email).trim() !== ""
      ? String(company.contact_email).trim().toLowerCase()
      : null;

  const email = companyEmail || profile.email || null;
  const whatsappRaw =
    company?.whatsapp != null && String(company.whatsapp).trim() !== ""
      ? String(company.whatsapp).replace(/\D/g, "")
      : profile.phone || null;

  return {
    tradeName,
    email,
    whatsapp: whatsappRaw,
    sellerCompanyId: company?.id != null ? String(company.id) : null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function findPrimaryCompanyRecipientRows(supabase, sellerId) {
  const { data, error } = await supabase
    .from("s7_notification_recipients")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("is_primary", true);

  if (error) throw error;
  return (data ?? []).filter(isPrimaryCompanyRecipientRow);
}

/**
 * @param {Array<Record<string, unknown>>} rows
 */
function primaryRecipientGroupIdFromRows(rows) {
  if (!rows.length) return null;
  const withCompany = rows.find((r) => r.seller_company_id != null);
  const anchor = withCompany ?? rows[0];
  return anchor.recipient_group_id != null ? String(anchor.recipient_group_id) : String(anchor.id);
}

/**
 * @param {Record<string, unknown> | undefined} row
 */
function parseRowMetadata(row) {
  if (!row || typeof row !== "object") return {};
  return row.metadata != null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? /** @type {Record<string, unknown>} */ (row.metadata)
    : {};
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {boolean} [includeDevCenter=false]
 */
async function listSellerFacingEventTypesForBootstrap(supabase, includeDevCenter = false) {
  const { data: types, error } = await supabase
    .from("s7_notification_event_types")
    .select("category_code, type_key, supported_channels")
    .eq("is_active", true);

  if (error) throw error;

  return (types ?? []).filter((t) => isCategoryVisibleToSeller(String(t.category_code), includeDevCenter));
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} groupId
 * @param {Record<string, unknown>} metadataSeed
 */
async function bootstrapPrimaryRecipientPreferencesOnce(supabase, sellerId, groupId, metadataSeed) {
  if (hasBootstrapPreferencesCompleted(metadataSeed)) {
    return { bootstrapped: false, reason: "already_bootstrapped" };
  }

  const eventTypes = await listSellerFacingEventTypesForBootstrap(supabase, false);
  const now = new Date().toISOString();

  for (const evt of eventTypes) {
    const category_code = String(evt.category_code);
    const type_key = String(evt.type_key);
    const supported = Array.isArray(evt.supported_channels) ? evt.supported_channels.map(String) : [];

    for (const channel of [S7_NOTIFICATION_CHANNEL.EMAIL, S7_NOTIFICATION_CHANNEL.WHATSAPP]) {
      if (!supported.includes(channel)) continue;

      const { data: existing } = await supabase
        .from("s7_notification_event_delivery_rules")
        .select("id")
        .eq("seller_id", sellerId)
        .eq("category_code", category_code)
        .eq("type_key", type_key)
        .eq("recipient_group_id", groupId)
        .eq("channel", channel)
        .maybeSingle();

      if (!existing?.id) {
        const { error: insErr } = await supabase.from("s7_notification_event_delivery_rules").insert({
          seller_id: sellerId,
          category_code,
          type_key,
          recipient_group_id: groupId,
          channel,
          enabled: true,
          created_at: now,
          updated_at: now,
        });
        if (insErr && String(insErr.code ?? "") !== "23505") throw insErr;
      }
    }

    if (supported.includes(S7_NOTIFICATION_CHANNEL.IN_APP)) {
      const { data: prefExisting } = await supabase
        .from("s7_notification_preferences")
        .select("id")
        .eq("seller_id", sellerId)
        .eq("category_code", category_code)
        .eq("type_key", type_key)
        .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
        .maybeSingle();

      if (!prefExisting?.id) {
        const { error: prefErr } = await supabase.from("s7_notification_preferences").insert({
          seller_id: sellerId,
          category_code,
          type_key,
          channel: S7_NOTIFICATION_CHANNEL.IN_APP,
          enabled: true,
          created_at: now,
          updated_at: now,
        });
        if (prefErr && String(prefErr.code ?? "") !== "23505") throw prefErr;
      }
    }
  }

  logNotificationRecipient("PRIMARY_BOOTSTRAP_PREFS_OK", {
    seller_id: sellerId,
    group_id: groupId,
  });

  return { bootstrapped: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} groupId
 * @param {{ email: string, whatsapp: string, label: string | null, sellerCompanyId: string | null }} contact
 * @param {Record<string, unknown>} metadata
 */
async function upsertPrimaryRecipientChannelRows(supabase, sellerId, groupId, contact, metadata) {
  const now = new Date().toISOString();
  const channels = [
    { channel: S7_NOTIFICATION_CHANNEL.EMAIL, destination: contact.email },
    { channel: S7_NOTIFICATION_CHANNEL.WHATSAPP, destination: contact.whatsapp },
  ];

  for (const ch of channels) {
    const norm = normalizeAndValidateRecipientDestination(ch.channel, ch.destination);
    if (!norm.ok) {
      return norm;
    }

    const { data: existingRow, error: findErr } = await supabase
      .from("s7_notification_recipients")
      .select("*")
      .eq("seller_id", sellerId)
      .eq("is_primary", true)
      .eq("channel", ch.channel)
      .maybeSingle();

    if (findErr) throw findErr;

    const dupe = await findDuplicateRecipientSlot(
      supabase,
      sellerId,
      ch.channel,
      norm.destination,
      existingRow?.id != null ? String(existingRow.id) : null
    );
    if (dupe && String(dupe.id) !== String(existingRow?.id ?? "")) {
      return {
        ok: false,
        error: "DUPLICATE_RECIPIENT",
        message:
          ch.channel === S7_NOTIFICATION_CHANNEL.EMAIL
            ? "E-mail da empresa principal já está em uso por outro destinatário."
            : "WhatsApp da empresa principal já está em uso por outro destinatário.",
      };
    }

    const label = contact.label ?? "Empresa principal";
    const rowPayload = {
      seller_id: sellerId,
      recipient_group_id: groupId,
      channel: ch.channel,
      destination: norm.destination,
      label,
      role_tag: existingRow?.role_tag ?? null,
      is_active: existingRow?.is_active !== false,
      is_primary: true,
      seller_company_id: contact.sellerCompanyId,
      metadata,
      updated_at: now,
    };

    if (existingRow?.id) {
      const { error } = await supabase
        .from("s7_notification_recipients")
        .update(rowPayload)
        .eq("id", existingRow.id)
        .eq("seller_id", sellerId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("s7_notification_recipients").insert({
        ...rowPayload,
        created_at: now,
      });
      if (error) {
        if (String(error.code ?? "") === "23505") {
          return { ok: false, error: "PRIMARY_RECIPIENT_RACE", message: "Destinatário padrão já existe." };
        }
        throw error;
      }
    }
  }

  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{ syncOnly?: boolean }} [options]
 */
export async function ensurePrimaryCompanyDefaultRecipient(supabase, sellerId, options = {}) {
  const company = await loadPrimarySellerCompany(supabase, sellerId);
  if (!company?.id) {
    return { ok: true, ensured: false, reason: "no_primary_company" };
  }

  const profile = await loadSellerProfileContact(supabase, sellerId);
  const contact = resolvePrimaryCompanyContactSources(company, profile);

  if (!contact.email || !contact.whatsapp) {
    logNotificationRecipient("PRIMARY_ENSURE_SKIPPED_INCOMPLETE", {
      seller_id: sellerId,
      has_email: Boolean(contact.email),
      has_whatsapp: Boolean(contact.whatsapp),
    });
    return { ok: true, ensured: false, reason: "incomplete_company_contact" };
  }

  const emailNorm = normalizeAndValidateRecipientDestination(S7_NOTIFICATION_CHANNEL.EMAIL, contact.email);
  const waNorm = normalizeAndValidateRecipientDestination(S7_NOTIFICATION_CHANNEL.WHATSAPP, contact.whatsapp);
  if (!emailNorm.ok || !waNorm.ok) {
    return { ok: true, ensured: false, reason: "invalid_company_contact" };
  }

  let existingRows = await findPrimaryCompanyRecipientRows(supabase, sellerId);
  let groupId = primaryRecipientGroupIdFromRows(existingRows);

  const anchorMeta = parseRowMetadata(existingRows[0]);
  let metadata = mergeRecipientMetadata(anchorMeta, {
    recipient_kind: S7_RECIPIENT_KIND.PRIMARY_COMPANY,
  });

  if (!groupId) {
    groupId = randomUUID();
  }

  const label =
    existingRows.length && isRecipientLabelCustomized(anchorMeta)
      ? String(existingRows[0]?.label ?? contact.tradeName ?? "Empresa principal")
      : contact.tradeName ?? "Empresa principal";

  const upsertResult = await upsertPrimaryRecipientChannelRows(
    supabase,
    sellerId,
    groupId,
    {
      email: emailNorm.destination,
      whatsapp: waNorm.destination,
      label,
      sellerCompanyId: contact.sellerCompanyId,
    },
    metadata
  );

  if (!upsertResult.ok) {
    if (upsertResult.error === "PRIMARY_RECIPIENT_RACE") {
      existingRows = await findPrimaryCompanyRecipientRows(supabase, sellerId);
      groupId = primaryRecipientGroupIdFromRows(existingRows);
    } else {
      return upsertResult;
    }
  }

  if (!groupId) {
    existingRows = await findPrimaryCompanyRecipientRows(supabase, sellerId);
    groupId = primaryRecipientGroupIdFromRows(existingRows);
  }

  if (!groupId) {
    return { ok: true, ensured: false, reason: "create_failed" };
  }

  existingRows = await findPrimaryCompanyRecipientRows(supabase, sellerId);
  const refreshedMeta = parseRowMetadata(existingRows[0]);

  if (!options.syncOnly) {
    const bootstrap = await bootstrapPrimaryRecipientPreferencesOnce(supabase, sellerId, groupId, refreshedMeta);
    if (bootstrap.bootstrapped) {
      const bootstrapMeta = mergeRecipientMetadata(refreshedMeta, {
        bootstrap_preferences_at: new Date().toISOString(),
      });
      await supabase
        .from("s7_notification_recipients")
        .update({ metadata: bootstrapMeta, updated_at: new Date().toISOString() })
        .eq("seller_id", sellerId)
        .eq("recipient_group_id", groupId);
    }
  }

  logNotificationRecipient("PRIMARY_ENSURE_OK", { seller_id: sellerId, group_id: groupId });
  return { ok: true, ensured: true, group_id: groupId };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function syncPrimaryCompanyRecipientContactsFromCompany(supabase, sellerId) {
  return ensurePrimaryCompanyDefaultRecipient(supabase, sellerId, { syncOnly: true });
}

/**
 * @param {Array<Record<string, unknown>>} existingRows
 */
export function isPrimaryCompanyRecipientGroupRows(existingRows) {
  if (!existingRows?.length) return false;
  return existingRows.some(isPrimaryCompanyRecipientRow);
}
