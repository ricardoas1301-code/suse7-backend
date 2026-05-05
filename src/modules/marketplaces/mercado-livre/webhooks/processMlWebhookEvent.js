// ======================================================
// Processador de ml_webhook_events — chamado pelo job interno
// orders → marketplace_sales | items → persist listing | shipments → re-sync order
// ======================================================

import { fetchShipmentById } from "../../../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { fetchItem, fetchItemDescription } from "../../../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { getValidMLToken } from "../../../../handlers/ml/_helpers/mlToken.js";
import { persistMercadoLibreListing } from "../../../../handlers/ml/_helpers/mlListingsPersist.js";
import {
  inferItemIdFromMlWebhook,
  inferOrderIdFromMlWebhook,
  inferShipmentIdFromMlWebhook,
} from "../../../../handlers/ml/_helpers/mlWebhookPayload.js";
import { syncMercadoLivreSingleOrderByAccountId } from "../sales/mlSalesSyncService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} marketplaceAccountId
 * @returns {Promise<{ user_id: string } | null>}
 */
async function loadAccountUserId(supabase, marketplaceAccountId) {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("user_id")
    .eq("id", marketplaceAccountId)
    .maybeSingle();
  if (error || !data?.user_id) return null;
  return { user_id: String(data.user_id) };
}

/**
 * @param {Record<string, unknown>} row — ml_webhook_events
 * @param {(msg: string, extra?: object) => void} log
 */
async function handleOrdersTopic(supabase, row, log) {
  const topic = String(row.topic || "");
  const resource = row.resource != null ? String(row.resource) : null;
  const orderId = inferOrderIdFromMlWebhook(topic, resource);
  const marketplaceAccountId =
    row.marketplace_account_id != null ? String(row.marketplace_account_id) : null;

  if (!marketplaceAccountId || !orderId) {
    log("orders_missing_ids", { topic, resource, marketplaceAccountId, orderId });
    return { ok: true, note: "missing_order_or_account" };
  }

  const summary = await syncMercadoLivreSingleOrderByAccountId({
    supabase,
    marketplaceAccountId,
    orderId,
    advanceSalesSyncCursor: true,
  });

  if (summary.error_count > 0) {
    const msg = summary.errors[0] || "order_sync_failed";
    const low = msg.toLowerCase();
    if (low.includes("token") || low.includes("oauth") || low.includes("401")) {
      console.error("[S7_ML_WEBHOOK] token_error", { marketplaceAccountId, msg });
    } else {
      console.error("[S7_ML_WEBHOOK] ml_api_error", { marketplaceAccountId, msg });
    }
    throw new Error(msg);
  }

  log("order_processed", { orderId, synced: summary.synced_count });
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} row
 * @param {(msg: string, extra?: object) => void} log
 */
async function handleItemsTopic(supabase, row, log) {
  const topic = String(row.topic || "");
  const resource = row.resource != null ? String(row.resource) : null;
  const itemId = inferItemIdFromMlWebhook(topic, resource);
  const marketplaceAccountId =
    row.marketplace_account_id != null ? String(row.marketplace_account_id) : null;

  if (!marketplaceAccountId || !itemId) {
    log("items_missing_ids", { topic, resource });
    return { ok: true, note: "missing_item_or_account" };
  }

  const acc = await loadAccountUserId(supabase, marketplaceAccountId);
  if (!acc) throw new Error("Conta ML não encontrada para items");

  let token;
  try {
    token = await getValidMLToken(acc.user_id, { marketplaceAccountId });
  } catch (e) {
    console.error("[S7_ML_WEBHOOK] token_error", {
      marketplaceAccountId,
      message: e?.message || String(e),
    });
    throw e;
  }

  const item = await fetchItem(token, itemId);
  let description = null;
  try {
    description = await fetchItemDescription(token, itemId);
  } catch (e) {
    log("item_description_optional_fail", { itemId, message: e?.message });
  }

  await persistMercadoLibreListing(supabase, acc.user_id, item, description, {
    accessToken: token,
    marketplaceAccountId,
    syncReason: "ml_webhook_items",
    log: (m, x) => log(m, x),
  });

  log("item_processed", { itemId });
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} row
 * @param {(msg: string, extra?: object) => void} log
 */
async function handleShipmentsTopic(supabase, row, log) {
  const topic = String(row.topic || "");
  const resource = row.resource != null ? String(row.resource) : null;
  const shipmentId = inferShipmentIdFromMlWebhook(topic, resource);
  const marketplaceAccountId =
    row.marketplace_account_id != null ? String(row.marketplace_account_id) : null;

  if (!marketplaceAccountId || !shipmentId) {
    log("shipments_missing_ids", { topic, resource });
    return { ok: true, note: "missing_shipment_or_account" };
  }

  const acc = await loadAccountUserId(supabase, marketplaceAccountId);
  if (!acc) throw new Error("Conta ML não encontrada para shipments");

  let token;
  try {
    token = await getValidMLToken(acc.user_id, { marketplaceAccountId });
  } catch (e) {
    console.error("[S7_ML_WEBHOOK] token_error", { marketplaceAccountId, message: e?.message });
    throw e;
  }

  const ship = await fetchShipmentById(token, shipmentId);
  const orderRaw =
    ship != null && typeof ship === "object"
      ? /** @type {Record<string, unknown>} */ (ship).order_id
      : null;
  if (orderRaw == null) {
    log("shipment_no_order_id", { shipmentId });
    return { ok: true, note: "no_order_on_shipment" };
  }

  const summary = await syncMercadoLivreSingleOrderByAccountId({
    supabase,
    marketplaceAccountId,
    orderId: String(orderRaw),
    advanceSalesSyncCursor: true,
  });

  if (summary.error_count > 0) {
    throw new Error(summary.errors[0] || "shipment_order_sync_failed");
  }

  log("shipment_processed", { shipmentId, orderId: String(orderRaw) });
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} row
 * @param {(msg: string, extra?: object) => void} log
 */
function handleDeferredTopic(row, log) {
  const t = String(row.topic || "").toLowerCase();
  console.info("[S7_ML_WEBHOOK] deferred_topic", { topic: t, id: row.id });
  log("deferred", { topic: t });
  return { ok: true, deferred: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} row
 */
export async function processOneMlWebhookEvent(supabase, row) {
  const id = row.id != null ? String(row.id) : "";
  const topicRaw = String(row.topic || "unknown");
  const t = topicRaw.toLowerCase();

  const log = (msg, extra = {}) => {
    console.info(`[S7_ML_WEBHOOK] process_${msg}`, { event_id: id, ...extra });
  };

  if (!row.marketplace_account_id) {
    console.warn("[S7_ML_WEBHOOK] skip_no_account", { id });
    return { ok: false, reason: "no_marketplace_account" };
  }

  if (t.includes("shipment")) {
    return handleShipmentsTopic(supabase, row, log);
  }
  if (t.includes("order")) {
    return handleOrdersTopic(supabase, row, log);
  }
  if (t.includes("item")) {
    return handleItemsTopic(supabase, row, log);
  }
  if (
    t.includes("payment") ||
    t.includes("claim") ||
    t.includes("mediation") ||
    t === "messages"
  ) {
    return handleDeferredTopic(row, log);
  }

  log("unknown_topic_ack", { topic: topicRaw });
  return { ok: true, note: "unknown_topic_acked" };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ batchSize?: number; maxAttempts?: number }} [opts]
 */
export async function processPendingMlWebhookEvents(supabase, opts = {}) {
  const batchSize = Math.min(
    500,
    Math.max(1, parseInt(String(opts.batchSize ?? process.env.ML_WEBHOOK_EVENTS_BATCH_SIZE || "100"), 10) || 100)
  );
  const maxAttempts = Math.min(
    50,
    Math.max(1, parseInt(String(opts.maxAttempts ?? process.env.ML_WEBHOOK_EVENTS_MAX_ATTEMPTS || "5"), 10) || 5)
  );

  const { data: pending, error: qErr } = await supabase
    .from("ml_webhook_events")
    .select("*")
    .eq("status", "pending")
    .not("marketplace_account_id", "is", null)
    .order("received_at", { ascending: true })
    .limit(batchSize);

  if (qErr) {
    console.error("[S7_ML_WEBHOOK] batch_query_failed", qErr.message);
    throw qErr;
  }

  const rows = pending ?? [];
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const row of rows) {
    const rid = row?.id != null ? String(row.id) : "";

    const { data: locked, error: lockErr } = await supabase
      .from("ml_webhook_events")
      .update({ status: "processing" })
      .eq("id", rid)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (lockErr || !locked?.id) {
      continue;
    }

    const prevAttempts = row.attempts != null ? Number(row.attempts) : 0;

    try {
      await processOneMlWebhookEvent(supabase, /** @type {Record<string, unknown>} */ (row));
      const fin = new Date().toISOString();
      await supabase
        .from("ml_webhook_events")
        .update({
          status: "processed",
          processed_at: fin,
          error_message: null,
        })
        .eq("id", rid);

      console.info("[S7_ML_WEBHOOK] event_processed", { id: rid });
      results.push({ id: rid, status: "processed" });
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e);
      const attempts = prevAttempts + 1;
      const failed = attempts >= maxAttempts;
      const nextStatus = failed ? "failed" : "pending";

      console.error("[S7_ML_WEBHOOK] event_process_error", {
        id: rid,
        attempts,
        maxAttempts,
        retry: !failed,
        message: msg,
      });

      if (!failed) {
        console.info("[S7_ML_WEBHOOK] retry_scheduled", { id: rid, attempts, maxAttempts });
      }

      await supabase
        .from("ml_webhook_events")
        .update({
          status: nextStatus,
          processed_at: failed ? new Date().toISOString() : null,
          error_message: msg.slice(0, 4000),
          attempts,
        })
        .eq("id", rid);

      results.push({ id: rid, status: nextStatus, error: msg });
    }
  }

  return { processed: results.length, results };
}
