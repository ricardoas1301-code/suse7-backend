// =============================================================================
// Destinatários agrupados (pessoa) — Opção A: N linhas por canal (Fase 3.2.2)
// =============================================================================

import { randomUUID } from "node:crypto";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { logNotificationRecipient } from "./sellerNotificationObservability.js";
import {
  RECIPIENT_ERROR,
  buildDuplicateRecipientError,
  findDuplicateRecipientSlot,
  normalizeAndValidateRecipientDestination,
} from "./sellerNotificationRecipientValidation.js";
import {
  DEFAULT_RECIPIENT_ERROR,
  isPrimaryCompanyRecipientRow,
  isRecipientLabelCustomized,
  mergeRecipientMetadata,
} from "../recipients/defaultRecipientPolicy.js";
import {
  ensurePrimaryCompanyDefaultRecipient,
  isPrimaryCompanyRecipientGroupRows,
} from "../recipients/primaryCompanyDefaultRecipientService.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {Array<Record<string, unknown>>} rows
 */
export function aggregateRecipientGroups(rows) {
  /** @type {Map<string, { group_id: string, label: string, role_tag: string | null, is_active: boolean, is_primary: boolean, seller_company_id: string | null, metadata: Record<string, unknown>, channels: Record<string, unknown> }>} */
  const map = new Map();

  for (const row of rows) {
    const gid = String(row.recipient_group_id ?? row.id);
    const rowMeta =
      row.metadata != null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? /** @type {Record<string, unknown>} */ (row.metadata)
        : {};
    const entry = map.get(gid) ?? {
      group_id: gid,
      label: String(row.label ?? ""),
      role_tag: row.role_tag != null ? String(row.role_tag) : null,
      is_active: row.is_active !== false,
      is_primary: isPrimaryCompanyRecipientRow(row),
      seller_company_id: row.seller_company_id != null ? String(row.seller_company_id) : null,
      metadata: { ...rowMeta },
      channels: {},
    };

    const ch = String(row.channel);
    entry.channels[ch] = {
      recipient_id: String(row.id),
      destination: row.destination,
      is_active: row.is_active !== false,
    };
    if (!entry.label && row.label) entry.label = String(row.label);
    entry.is_active = entry.is_active || row.is_active !== false;
    entry.is_primary = entry.is_primary || isPrimaryCompanyRecipientRow(row);
    if (row.seller_company_id != null) {
      entry.seller_company_id = String(row.seller_company_id);
    }
    if (Object.keys(rowMeta).length) {
      entry.metadata = { ...entry.metadata, ...rowMeta };
    }
    if (row.role_tag != null && String(row.role_tag).trim() !== "") {
      entry.role_tag = String(row.role_tag);
    }
    map.set(gid, entry);
  }

  return [...map.values()].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} recipientIds
 */
async function loadScopesByRecipientIds(supabase, recipientIds) {
  if (recipientIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("s7_notification_recipient_scopes")
    .select("id, recipient_id, category_code, type_key, is_active")
    .in("recipient_id", recipientIds)
    .eq("is_active", true);

  if (error) throw error;

  /** @type {Map<string, Array<{ id: string, category_code: string, type_key: string | null }>>} */
  const map = new Map();
  for (const s of data ?? []) {
    const rid = String(s.recipient_id);
    const list = map.get(rid) ?? [];
    list.push({
      id: String(s.id),
      category_code: String(s.category_code),
      type_key: s.type_key != null ? String(s.type_key) : null,
    });
    map.set(rid, list);
  }
  return map;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function listSellerNotificationRecipientGroups(supabase, sellerId) {
  await ensurePrimaryCompanyDefaultRecipient(supabase, sellerId);

  const { data, error } = await supabase
    .from("s7_notification_recipients")
    .select("*")
    .eq("seller_id", sellerId)
    .order("label", { ascending: true });

  if (error) throw error;

  const rows = data ?? [];
  const ids = rows.map((r) => String(r.id));
  const scopesMap = await loadScopesByRecipientIds(supabase, ids);
  const recipients = rows.map((row) => ({
    ...row,
    scopes: scopesMap.get(String(row.id)) ?? [],
  }));

  const groups = aggregateRecipientGroups(recipients);
  logNotificationRecipient("LIST_GROUPS_OK", { seller_id: sellerId, count: groups.length });

  return {
    groups,
    recipients,
  };
}

/**
 * @param {Record<string, unknown>} body
 */
function parsePersonPayload(body) {
  const label = body.label != null ? String(body.label).trim().slice(0, 120) : "";
  if (!label) {
    return { ok: false, error: "INVALID_LABEL", message: "Nome do destinatário é obrigatório." };
  }

  const emailRaw = body.email != null ? String(body.email).trim() : "";
  const whatsappRaw = body.whatsapp != null ? String(body.whatsapp).trim() : "";

  if (!emailRaw) {
    return {
      ok: false,
      error: RECIPIENT_ERROR.INVALID_RECIPIENT_DESTINATION,
      field: "email",
      message: "E-mail é obrigatório.",
    };
  }
  if (!whatsappRaw) {
    return {
      ok: false,
      error: RECIPIENT_ERROR.INVALID_RECIPIENT_DESTINATION,
      field: "whatsapp",
      message: "WhatsApp é obrigatório.",
    };
  }

  const emailNorm = normalizeAndValidateRecipientDestination(S7_NOTIFICATION_CHANNEL.EMAIL, emailRaw);
  if (!emailNorm.ok) return emailNorm;

  const waNorm = normalizeAndValidateRecipientDestination(S7_NOTIFICATION_CHANNEL.WHATSAPP, whatsappRaw);
  if (!waNorm.ok) return waNorm;

  const channels = [
    { channel: emailNorm.channel, destination: emailNorm.destination },
    { channel: waNorm.channel, destination: waNorm.destination },
  ];

  return {
    ok: true,
    label,
    role_tag: body.role_tag != null ? String(body.role_tag).trim().slice(0, 80) : null,
    is_active: body.is_active !== false,
    channels,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Record<string, unknown>} body
 */
export async function createSellerNotificationRecipientGroup(supabase, sellerId, body) {
  const parsed = parsePersonPayload(body);
  if (!parsed.ok) return parsed;

  for (const ch of parsed.channels) {
    const dupe = await findDuplicateRecipientSlot(supabase, sellerId, ch.channel, ch.destination, null);
    if (dupe) return buildDuplicateRecipientError(ch.channel);
  }

  const groupId = randomUUID();
  const now = new Date().toISOString();

  for (const ch of parsed.channels) {
    const { error } = await supabase.from("s7_notification_recipients").insert({
      seller_id: sellerId,
      recipient_group_id: groupId,
      channel: ch.channel,
      destination: ch.destination,
      label: parsed.label,
      role_tag: parsed.role_tag,
      is_active: parsed.is_active,
      is_primary: false,
      metadata: {},
      created_at: now,
      updated_at: now,
    });
    if (error) {
      if (error.code === "23505") return buildDuplicateRecipientError(ch.channel);
      throw error;
    }
  }

  logNotificationRecipient("CREATE_GROUP_OK", { seller_id: sellerId, group_id: groupId });
  const listed = await listSellerNotificationRecipientGroups(supabase, sellerId);
  const group = listed.groups.find((g) => g.group_id === groupId);
  return { ok: true, group: group ?? null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} groupId
 * @param {Record<string, unknown>} body
 */
export async function patchSellerNotificationRecipientGroup(supabase, sellerId, groupId, body) {
  if (!UUID_RE.test(groupId)) {
    return { ok: false, error: "INVALID_ID", message: "Grupo inválido." };
  }

  const { data: existingRows, error: findErr } = await supabase
    .from("s7_notification_recipients")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("recipient_group_id", groupId);

  if (findErr) throw findErr;
  if (!existingRows?.length) {
    return { ok: false, error: "NOT_FOUND", message: "Destinatário não encontrado." };
  }

  if (isPrimaryCompanyRecipientGroupRows(existingRows)) {
    if (body.email !== undefined || body.whatsapp !== undefined) {
      return {
        ok: false,
        error: DEFAULT_RECIPIENT_ERROR.PRIMARY_CONTACT_LOCKED,
        message: "E-mail e WhatsApp do destinatário padrão são gerenciados em Dados da Empresa.",
      };
    }
  }

  const label =
    body.label != null ? String(body.label).trim().slice(0, 120) : String(existingRows[0].label);
  const role_tag =
    body.role_tag != null
      ? String(body.role_tag).trim().slice(0, 80) || null
      : existingRows[0].role_tag;
  const is_active =
    typeof body.is_active === "boolean" ? body.is_active : existingRows[0].is_active !== false;

  const emailProvided = body.email !== undefined;
  const whatsappProvided = body.whatsapp !== undefined;

  if (emailProvided || whatsappProvided) {
    const synthetic = {
      label,
      role_tag,
      is_active,
      email: emailProvided ? body.email : existingRows.find((r) => r.channel === "email")?.destination ?? "",
      whatsapp: whatsappProvided
        ? body.whatsapp
        : existingRows.find((r) => r.channel === "whatsapp")?.destination ?? "",
    };
    const parsed = parsePersonPayload(synthetic);
    if (!parsed.ok) return parsed;

    for (const ch of parsed.channels) {
      const dupe = await findDuplicateRecipientSlot(
        supabase,
        sellerId,
        ch.channel,
        ch.destination,
        null
      );
      if (dupe) {
        const sameGroup = existingRows.some(
          (r) => r.channel === ch.channel && String(r.destination) === ch.destination
        );
        if (!sameGroup) return buildDuplicateRecipientError(ch.channel);
      }
    }

    const now = new Date().toISOString();
    for (const channelKey of [S7_NOTIFICATION_CHANNEL.EMAIL, S7_NOTIFICATION_CHANNEL.WHATSAPP]) {
      const desired = parsed.channels.find((c) => c.channel === channelKey);
      const row = existingRows.find((r) => r.channel === channelKey);

      if (desired) {
        if (row) {
          await supabase
            .from("s7_notification_recipients")
            .update({
              destination: desired.destination,
              label,
              role_tag,
              is_active,
              updated_at: now,
            })
            .eq("id", row.id)
            .eq("seller_id", sellerId);
        } else {
          await supabase.from("s7_notification_recipients").insert({
            seller_id: sellerId,
            recipient_group_id: groupId,
            channel: channelKey,
            destination: desired.destination,
            label,
            role_tag,
            is_active,
            metadata: {},
            created_at: now,
            updated_at: now,
          });
        }
      } else if (row) {
        await supabase.from("s7_notification_recipients").delete().eq("id", row.id);
      }
    }
  } else {
    const isPrimary = isPrimaryCompanyRecipientGroupRows(existingRows);
    const now = new Date().toISOString();
    /** @type {Record<string, unknown>} */
    const updatePayload = { label, role_tag, is_active, updated_at: now };

    if (isPrimary && body.label !== undefined) {
      const prevLabel = String(existingRows[0]?.label ?? "");
      if (label !== prevLabel) {
        const baseMeta =
          existingRows[0]?.metadata != null &&
          typeof existingRows[0].metadata === "object" &&
          !Array.isArray(existingRows[0].metadata)
            ? /** @type {Record<string, unknown>} */ (existingRows[0].metadata)
            : {};
        updatePayload.metadata = mergeRecipientMetadata(baseMeta, { label_customized: true });
      }
    }

    await supabase
      .from("s7_notification_recipients")
      .update(updatePayload)
      .eq("seller_id", sellerId)
      .eq("recipient_group_id", groupId);
  }

  logNotificationRecipient("PATCH_GROUP_OK", { seller_id: sellerId, group_id: groupId });
  const listed = await listSellerNotificationRecipientGroups(supabase, sellerId);
  return {
    ok: true,
    group: listed.groups.find((g) => g.group_id === groupId) ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} groupId
 */
export async function deleteSellerNotificationRecipientGroup(supabase, sellerId, groupId) {
  if (!UUID_RE.test(groupId)) {
    return { ok: false, error: "INVALID_ID", message: "Grupo inválido." };
  }

  const { data: existingRows, error: findErr } = await supabase
    .from("s7_notification_recipients")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("recipient_group_id", groupId);

  if (findErr) throw findErr;
  if (!existingRows?.length) {
    return { ok: false, error: "NOT_FOUND", message: "Destinatário não encontrado." };
  }

  if (isPrimaryCompanyRecipientGroupRows(existingRows)) {
    return {
      ok: false,
      error: DEFAULT_RECIPIENT_ERROR.PRIMARY_DELETE_FORBIDDEN,
      message: "O destinatário padrão da empresa principal não pode ser removido.",
    };
  }

  const { error } = await supabase
    .from("s7_notification_recipients")
    .delete()
    .eq("seller_id", sellerId)
    .eq("recipient_group_id", groupId);

  if (error) throw error;

  await supabase
    .from("s7_notification_event_delivery_rules")
    .delete()
    .eq("seller_id", sellerId)
    .eq("recipient_group_id", groupId);

  logNotificationRecipient("DELETE_GROUP_OK", { seller_id: sellerId, group_id: groupId });
  return { ok: true, deleted_group_id: groupId };
}
