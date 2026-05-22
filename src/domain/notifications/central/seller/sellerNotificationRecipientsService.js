// =============================================================================
// Destinatários seller — CRUD (Fase 3.1.1 + integridade 3.2.1)
// =============================================================================

import { randomUUID } from "node:crypto";
import { isValidNotificationCategory } from "../constants/categories.js";
import { logNotificationRecipient } from "./sellerNotificationObservability.js";
import {
  RECIPIENT_ERROR,
  buildDuplicateRecipientError,
  findDuplicateRecipientSlot,
  normalizeAndValidateRecipientDestination,
} from "./sellerNotificationRecipientValidation.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
export async function listSellerNotificationRecipients(supabase, sellerId) {
  const { data, error } = await supabase
    .from("s7_notification_recipients")
    .select("*")
    .eq("seller_id", sellerId)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) throw error;

  const rows = data ?? [];
  const ids = rows.map((r) => String(r.id));
  const scopesMap = await loadScopesByRecipientIds(supabase, ids);

  const recipients = rows.map((row) => ({
    ...row,
    scopes: scopesMap.get(String(row.id)) ?? [],
  }));

  logNotificationRecipient("LIST_OK", { seller_id: sellerId, count: recipients.length });
  return { recipients };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} channel
 * @param {string} destination
 * @param {string | null} excludeId
 */
async function assertNoDuplicateRecipient(supabase, sellerId, channel, destination, excludeId) {
  const dupe = await findDuplicateRecipientSlot(supabase, sellerId, channel, destination, excludeId);
  if (dupe) return buildDuplicateRecipientError(channel);
  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Record<string, unknown>} body
 */
export async function createSellerNotificationRecipient(supabase, sellerId, body) {
  const label = body.label != null ? String(body.label).trim().slice(0, 120) : "";
  if (!label) {
    return { ok: false, error: "INVALID_LABEL", message: "Nome do destinatário é obrigatório." };
  }

  const normalized = normalizeAndValidateRecipientDestination(body.channel, body.destination);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error, message: normalized.message };
  }

  const dupeCheck = await assertNoDuplicateRecipient(
    supabase,
    sellerId,
    normalized.channel,
    normalized.destination,
    null
  );
  if (!dupeCheck.ok) {
    logNotificationRecipient("CREATE_DUPLICATE", {
      seller_id: sellerId,
      channel: normalized.channel,
    });
    return dupeCheck;
  }

  const now = new Date().toISOString();
  const groupId = randomUUID();
  const { data: inserted, error } = await supabase
    .from("s7_notification_recipients")
    .insert({
      seller_id: sellerId,
      recipient_group_id: groupId,
      channel: normalized.channel,
      destination: normalized.destination,
      label,
      role_tag: body.role_tag != null ? String(body.role_tag).trim().slice(0, 80) : null,
      marketplace_account_id: body.marketplace_account_id ?? null,
      seller_company_id: body.seller_company_id ?? null,
      is_active: body.is_active !== false,
      is_primary: Boolean(body.is_primary),
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") return buildDuplicateRecipientError(normalized.channel);
    logNotificationRecipient("CREATE_ERR", { message: error.message });
    throw error;
  }

  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  await replaceRecipientScopes(supabase, String(inserted.id), scopes);

  logNotificationRecipient("CREATE_OK", {
    seller_id: sellerId,
    recipient_id: inserted.id,
    channel: normalized.channel,
  });

  const scopesMap = await loadScopesByRecipientIds(supabase, [String(inserted.id)]);
  return {
    ok: true,
    recipient: {
      ...inserted,
      scopes: scopesMap.get(String(inserted.id)) ?? [],
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} recipientId
 * @param {Array<{ category_code: string, type_key?: string | null }>} scopes
 */
async function replaceRecipientScopes(supabase, recipientId, scopes) {
  await supabase.from("s7_notification_recipient_scopes").delete().eq("recipient_id", recipientId);

  const rows = [];
  for (const s of scopes) {
    const category_code = String(s.category_code ?? "").trim();
    if (!isValidNotificationCategory(category_code)) continue;
    const type_key =
      s.type_key != null && String(s.type_key).trim() !== "" ? String(s.type_key).trim() : null;
    rows.push({
      recipient_id: recipientId,
      category_code,
      type_key,
      is_active: true,
    });
  }

  if (rows.length === 0) return;

  const { error } = await supabase.from("s7_notification_recipient_scopes").insert(rows);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} recipientId
 * @param {Record<string, unknown>} body
 */
export async function patchSellerNotificationRecipient(supabase, sellerId, recipientId, body) {
  if (!UUID_RE.test(recipientId)) {
    return { ok: false, error: "INVALID_ID", message: "ID inválido." };
  }

  const { data: existing, error: findErr } = await supabase
    .from("s7_notification_recipients")
    .select("*")
    .eq("id", recipientId)
    .eq("seller_id", sellerId)
    .maybeSingle();

  if (findErr) throw findErr;
  if (!existing) {
    return { ok: false, error: "NOT_FOUND", message: "Destinatário não encontrado." };
  }

  const channel =
    body.channel != null && String(body.channel).trim() !== ""
      ? String(body.channel).trim()
      : String(existing.channel);

  if (String(existing.channel) !== channel) {
    return {
      ok: false,
      error: RECIPIENT_ERROR.INVALID_CHANNEL,
      message: "Alteração de canal não é permitida. Crie um novo destinatário.",
    };
  }

  const destinationRaw =
    body.destination != null ? body.destination : existing.destination;

  const normalized = normalizeAndValidateRecipientDestination(channel, destinationRaw);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error, message: normalized.message };
  }

  const dupeCheck = await assertNoDuplicateRecipient(
    supabase,
    sellerId,
    normalized.channel,
    normalized.destination,
    recipientId
  );
  if (!dupeCheck.ok) {
    logNotificationRecipient("PATCH_DUPLICATE", { seller_id: sellerId, recipient_id: recipientId });
    return dupeCheck;
  }

  const patch = {
    updated_at: new Date().toISOString(),
    destination: normalized.destination,
  };

  if (body.label != null) patch.label = String(body.label).trim().slice(0, 120);
  if (body.role_tag != null) patch.role_tag = String(body.role_tag).trim().slice(0, 80) || null;
  if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
  if (typeof body.is_primary === "boolean") patch.is_primary = body.is_primary;

  const { error: updErr } = await supabase
    .from("s7_notification_recipients")
    .update(patch)
    .eq("id", recipientId)
    .eq("seller_id", sellerId);

  if (updErr) {
    if (updErr.code === "23505") return buildDuplicateRecipientError(normalized.channel);
    throw updErr;
  }

  if (Array.isArray(body.scopes)) {
    await replaceRecipientScopes(supabase, recipientId, body.scopes);
  }

  logNotificationRecipient("PATCH_OK", { seller_id: sellerId, recipient_id: recipientId });

  const { data: refreshed, error: refErr } = await supabase
    .from("s7_notification_recipients")
    .select("*")
    .eq("id", recipientId)
    .eq("seller_id", sellerId)
    .maybeSingle();

  if (refErr) throw refErr;

  const scopesMap = await loadScopesByRecipientIds(supabase, [recipientId]);
  return {
    ok: true,
    recipient: refreshed ? { ...refreshed, scopes: scopesMap.get(recipientId) ?? [] } : null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} recipientId
 */
export async function deleteSellerNotificationRecipient(supabase, sellerId, recipientId) {
  if (!UUID_RE.test(recipientId)) {
    return { ok: false, error: "INVALID_ID", message: "ID inválido." };
  }

  const { data: existing, error: findErr } = await supabase
    .from("s7_notification_recipients")
    .select("id")
    .eq("id", recipientId)
    .eq("seller_id", sellerId)
    .maybeSingle();

  if (findErr) throw findErr;
  if (!existing) {
    return { ok: false, error: "NOT_FOUND", message: "Destinatário não encontrado." };
  }

  const { error } = await supabase
    .from("s7_notification_recipients")
    .delete()
    .eq("id", recipientId)
    .eq("seller_id", sellerId);

  if (error) throw error;

  logNotificationRecipient("DELETE_OK", { seller_id: sellerId, recipient_id: recipientId });
  return { ok: true, deleted_id: recipientId };
}
