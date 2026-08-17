// =============================================================================
// Inbox in-app — leitura e marcação (Fase 3.3)
// Fonte: s7_notification_dispatches WHERE channel = in_app
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { logInAppNotification } from "../inbox/inAppNotificationLog.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * @param {Record<string, unknown>} row
 */
function inboxField(row, key, fallback = "") {
  if (row[key] != null && String(row[key]).trim() !== "") return row[key];
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : null;
  const inbox = meta?.inbox && typeof meta.inbox === "object" ? meta.inbox : null;
  if (inbox?.[key] != null) return inbox[key];
  return fallback;
}

/**
 * @param {Record<string, unknown>} row
 */
function mapInboxItem(row) {
  const eventRow =
    row.event && typeof row.event === "object" && !Array.isArray(row.event) ? row.event : null;
  const category = String(inboxField(row, "category_code", "") ?? "");
  const typeKey = String(inboxField(row, "type_key", "") ?? "");
  const metaRead = inboxField(row, "is_read", null);
  const isRead =
    row.is_read === true ||
    metaRead === true ||
    row.read_at != null ||
    inboxField(row, "read_at", null) != null;

  return {
    id: String(row.id),
    seller_id: String(row.seller_id),
    event_type_key: typeKey ? `${category}:${typeKey}` : category || null,
    category_code: category || null,
    type_key: typeKey || null,
    title: String(inboxField(row, "title", row.rendered_subject ?? "")),
    message: String(inboxField(row, "message", row.rendered_body ?? "")),
    severity: String(inboxField(row, "severity", "info")),
    channel: S7_NOTIFICATION_CHANNEL.IN_APP,
    status: row.status != null ? String(row.status) : null,
    is_read: isRead,
    read_at: row.read_at ?? inboxField(row, "read_at", null),
    created_at: row.created_at ?? null,
    deep_link:
      row.deep_link != null
        ? String(row.deep_link)
        : inboxField(row, "deep_link", null) != null
          ? String(inboxField(row, "deep_link", null))
          : null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    event_id: row.event_id != null ? String(row.event_id) : null,
    event_payload:
      eventRow?.payload && typeof eventRow.payload === "object" ? eventRow.payload : null,
    event_metadata:
      eventRow?.metadata && typeof eventRow.metadata === "object" ? eventRow.metadata : null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
async function countUnreadInApp(supabase, sellerId) {
  const { data: rows, error: listErr } = await supabase
    .from("s7_notification_dispatches")
    .select("id, metadata, rendered_subject, rendered_body, created_at, event:s7_notification_events(id,payload,metadata,created_at)")
    .eq("seller_id", sellerId)
    .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
    .order("created_at", { ascending: false })
    .limit(200);

  if (listErr) throw listErr;
  return (rows ?? []).filter((row) => !mapInboxItem(row).is_read).length;
}

// Contagem via metadata até migration 20260522180000 (is_read) estar aplicada em DEV/prod.

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   limit?: number;
 *   cursor?: string | null;
 *   unreadOnly?: boolean;
 * }} input
 */
export async function listSellerNotificationInbox(supabase, input) {
  const sellerId = String(input.sellerId ?? "").trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIMIT));
  const unreadOnly = input.unreadOnly === true;

  let query = supabase
    .from("s7_notification_dispatches")
    .select(
      "id, seller_id, event_id, channel, status, created_at, metadata, rendered_subject, rendered_body, priority, event:s7_notification_events(id,payload,metadata,created_at)"
    )
    .eq("seller_id", sellerId)
    .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  const filterUnreadInMemory = unreadOnly;

  if (input.cursor) {
    const createdAt = String(input.cursor).split("|")[0]?.trim();
    if (createdAt) query = query.lt("created_at", createdAt);
  }

  const { data, error } = await query;
  if (error) throw error;
  const unreadCount = await countUnreadInApp(supabase, sellerId);

  let rows = Array.isArray(data) ? data : [];
  if (filterUnreadInMemory && unreadOnly) {
    rows = rows.filter((row) => {
      const mapped = mapInboxItem(row);
      return !mapped.is_read;
    });
  }
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapInboxItem);
  const last = items[items.length - 1];
  const cursor =
    hasMore && last?.created_at && last?.id ? `${last.created_at}|${last.id}` : null;

  logInAppNotification("INBOX_LIST", {
    seller_id: sellerId,
    count: items.length,
    unread_count: unreadCount,
    has_more: hasMore,
  });

  return { items, unread_count: unreadCount, cursor, has_more: hasMore };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} dispatchId
 */
export async function markSellerInboxItemRead(supabase, sellerId, dispatchId) {
  const now = new Date().toISOString();

  let row = null;
  let loadErr = null;
  {
    const attempt = await supabase
      .from("s7_notification_dispatches")
      .select("id, is_read, read_at, metadata")
      .eq("id", dispatchId)
      .eq("seller_id", sellerId)
      .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
      .maybeSingle();
    row = attempt.data;
    loadErr = attempt.error;
  }

  if (loadErr && isMissingInboxColumnError(loadErr)) {
    const retry = await supabase
      .from("s7_notification_dispatches")
      .select("id, metadata")
      .eq("id", dispatchId)
      .eq("seller_id", sellerId)
      .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
      .maybeSingle();
    row = retry.data;
    loadErr = retry.error;
  }

  if (loadErr) throw loadErr;
  if (!row) return { ok: false, error: "NOT_FOUND" };

  const mapped = mapInboxItem(row);
  if (mapped.is_read) {
    return { ok: true, item: { id: row.id, is_read: true, read_at: mapped.read_at }, already_read: true };
  }

  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? { ...row.metadata }
      : {};
  const inbox =
    meta.inbox && typeof meta.inbox === "object" && !Array.isArray(meta.inbox)
      ? { ...meta.inbox, is_read: true, read_at: now }
      : { is_read: true, read_at: now };

  const patch = {
    read_at: now,
    updated_at: now,
    metadata: { ...meta, inbox },
    is_read: true,
  };

  let { data, error } = await supabase
    .from("s7_notification_dispatches")
    .update(patch)
    .eq("id", dispatchId)
    .eq("seller_id", sellerId)
    .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
    .select("id, is_read, read_at")
    .maybeSingle();

  if (error && isMissingInboxColumnError(error)) {
    const retry = await supabase
      .from("s7_notification_dispatches")
      .update({ updated_at: now, metadata: { ...meta, inbox } })
      .eq("id", dispatchId)
      .eq("seller_id", sellerId)
      .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
      .select("id, metadata")
      .maybeSingle();
    data = retry.data ? { id: retry.data.id, is_read: true, read_at: now } : null;
    error = retry.error;
  }

  if (error) throw error;
  if (!data) return { ok: false, error: "NOT_FOUND" };

  logInAppNotification("INBOX_MARK_READ", { seller_id: sellerId, dispatch_id: dispatchId });
  return { ok: true, item: data, already_read: false };
}

/**
 * @param {{ code?: string; message?: string } | null} err
 */
function isMissingInboxColumnError(err) {
  const msg = String(err?.message ?? "").toLowerCase();
  return (
    err?.code === "PGRST204" ||
    err?.code === "42703" ||
    msg.includes("is_read") ||
    msg.includes("read_at") ||
    msg.includes("category_code") ||
    msg.includes("deep_link")
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function markAllSellerInboxRead(supabase, sellerId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("s7_notification_dispatches")
    .update({ is_read: true, read_at: now, updated_at: now })
    .eq("seller_id", sellerId)
    .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
    .or("is_read.is.null,is_read.eq.false")
    .select("id");

  if (!error) {
    const updated = Array.isArray(data) ? data.length : 0;
    logInAppNotification("INBOX_MARK_ALL_READ", { seller_id: sellerId, updated_count: updated });
    return { ok: true, updated_count: updated, read_at: now };
  }

  if (!isMissingInboxColumnError(error)) throw error;

  const { data: unreadRows, error: listErr } = await supabase
    .from("s7_notification_dispatches")
    .select("id, metadata")
    .eq("seller_id", sellerId)
    .eq("channel", S7_NOTIFICATION_CHANNEL.IN_APP)
    .limit(500);

  if (listErr) throw listErr;

  let updated = 0;
  for (const row of unreadRows ?? []) {
    if (mapInboxItem(row).is_read) continue;
    const meta =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? { ...row.metadata }
        : {};
    const inbox =
      meta.inbox && typeof meta.inbox === "object" && !Array.isArray(meta.inbox)
        ? { ...meta.inbox, is_read: true, read_at: now }
        : { is_read: true, read_at: now };
    const { error: upErr } = await supabase
      .from("s7_notification_dispatches")
      .update({ updated_at: now, metadata: { ...meta, inbox } })
      .eq("id", row.id);
    if (!upErr) updated += 1;
  }

  logInAppNotification("INBOX_MARK_ALL_READ", { seller_id: sellerId, updated_count: updated, mode: "metadata" });
  return { ok: true, updated_count: updated, read_at: now };
}
