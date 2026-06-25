// =====================================================
// S7 ML WEBHOOK PROCESSOR
// Responsável por processar eventos pendentes do ML (orders_v2)
// =====================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { fetchOrderById } from "./_helpers/mercadoLibreOrdersApi.js";
import { enrichMlOrderBuyerThumbnailIfNeeded } from "../../modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { applyMlOrderDetailToMarketplaceSales } from "../../modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { inferOrderIdFromMlWebhook, inferShipmentIdFromMlWebhook } from "./_helpers/mlWebhookPayload.js";

/**
 * @returns {import("@supabase/supabase-js").SupabaseClient}
 */
function getSupabaseAdmin() {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Interface shape para múltiplos marketplaces.
 * @typedef {{ handle: (event: Record<string, unknown>) => Promise<void> }} WebhookHandler
 */

/** @type {WebhookHandler} */
export const MercadoLivreWebhookHandler = {
  /**
   * @param {Record<string, unknown>} event
   */
  async handle(event) {
    if (String(event.topic || "").toLowerCase() !== "orders_v2") return;
    const supabase = getSupabaseAdmin();
    await processOrderEvent(supabase, event);
  },
};

/**
 * @param {string | null | undefined} resource
 */
function extractOrderId(resource) {
  const fromHelper = inferOrderIdFromMlWebhook("orders_v2", resource ?? null);
  if (fromHelper) return fromHelper;
  if (!resource) return null;
  const parts = String(resource)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || null;
}

function pickSellerIdFromOrder(order) {
  if (!order || typeof order !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (order);
  const sellerObj = o.seller && typeof o.seller === "object" ? /** @type {Record<string, unknown>} */ (o.seller) : null;
  const collectorObj =
    o.collector && typeof o.collector === "object" ? /** @type {Record<string, unknown>} */ (o.collector) : null;
  const raw =
    sellerObj?.id ??
    o.seller_id ??
    o.sellerId ??
    collectorObj?.id ??
    null;
  return raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
}

function pickPackIdFromOrder(order) {
  if (!order || typeof order !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (order);
  const raw = o.pack_id ?? o.packId ?? null;
  return raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
}

function isSchemaColumnError(error) {
  const code = error?.code != null ? String(error.code) : "";
  const msg = error?.message != null ? String(error.message).toLowerCase() : "";
  return code === "42703" || code.toUpperCase() === "PGRST204" || msg.includes("schema cache") || msg.includes("column");
}

async function updateWebhookEventRow(supabase, eventId, patch) {
  const withHeartbeat = { ...patch, updated_at: new Date().toISOString() };
  if (patch.status === "processing" && withHeartbeat.heartbeat_at == null) {
    withHeartbeat.heartbeat_at = withHeartbeat.updated_at;
  }
  const { error } = await supabase.from("ml_webhook_events").update(withHeartbeat).eq("id", eventId);
  if (!error) return;
  if (!isSchemaColumnError(error)) throw error;
  const fallbackPatch = { ...withHeartbeat };
  delete fallbackPatch.last_error_code;
  delete fallbackPatch.last_error_message;
  delete fallbackPatch.started_at;
  delete fallbackPatch.completed_at;
  delete fallbackPatch.heartbeat_at;
  const { error: fallbackError } = await supabase
    .from("ml_webhook_events")
    .update(fallbackPatch)
    .eq("id", eventId);
  if (fallbackError) throw fallbackError;
}

function resolveMlWebhookEventsBudgetMs() {
  return Math.min(
    55000,
    Math.max(3000, parseInt(process.env.ML_WEBHOOK_EVENTS_BUDGET_MS || "25000", 10) || 25000)
  );
}

function resolveMlWebhookProcessingStaleMs() {
  return Math.min(
    60 * 60 * 1000,
    Math.max(60 * 1000, parseInt(process.env.ML_WEBHOOK_EVENTS_PROCESSING_STALE_MS || "900000", 10) || 900000)
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function reclaimStaleMlWebhookProcessingEvents(supabase) {
  const staleMs = resolveMlWebhookProcessingStaleMs();
  const cutoffIso = new Date(Date.now() - staleMs).toISOString();
  const { data: rows, error } = await supabase
    .from("ml_webhook_events")
    .select("id,topic,resource,marketplace_account_id,updated_at,heartbeat_at")
    .eq("status", "processing")
    .lt("updated_at", cutoffIso)
    .limit(100);
  if (error) {
    console.warn("[ml-webhook-events-job] stale_processing_scan_failed", { message: error.message });
    return 0;
  }
  let reclaimed = 0;
  const nowIso = new Date().toISOString();
  for (const row of rows || []) {
    const { error: updErr } = await supabase
      .from("ml_webhook_events")
      .update({
        status: "pending",
        error_message: `reclaimed_stale_processing>${staleMs}ms`,
        last_error_code: "STALE_PROCESSING_RECLAIMED",
        last_error_message: `reclaimed_stale_processing>${staleMs}ms`,
        heartbeat_at: null,
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .eq("status", "processing");
    if (!updErr) {
      reclaimed += 1;
      console.warn("[ml-webhook-events-job] stale_processing_reclaimed", {
        event_id: row.id,
        topic: row.topic ?? null,
        resource: row.resource ?? null,
        marketplace_account_id: row.marketplace_account_id ?? null,
        stale_timeout_ms: staleMs,
      });
    }
  }
  return reclaimed;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {number} batchSize
 */
async function fetchPendingMlWebhookEvents(supabase, batchSize) {
  const orderLimit = Math.max(1, Math.min(batchSize, Math.ceil(batchSize * 0.75) || batchSize));
  const { data: orderEvents, error: orderErr } = await supabase
    .from("ml_webhook_events")
    .select("*")
    .eq("status", "pending")
    .eq("topic", "orders_v2")
    .order("created_at", { ascending: true })
    .limit(orderLimit);
  if (orderErr) throw orderErr;
  const picked = Array.isArray(orderEvents) ? [...orderEvents] : [];
  const pickedIds = new Set(picked.map((row) => String(row.id || "")));
  const remaining = Math.max(0, batchSize - picked.length);
  if (remaining > 0) {
    const { data: otherEvents, error: otherErr } = await supabase
      .from("ml_webhook_events")
      .select("*")
      .eq("status", "pending")
      .neq("topic", "orders_v2")
      .order("created_at", { ascending: true })
      .limit(remaining);
    if (otherErr) throw otherErr;
    for (const row of otherEvents || []) {
      const id = String(row.id || "");
      if (!id || pickedIds.has(id)) continue;
      picked.push(row);
      pickedIds.add(id);
    }
  }
  return picked;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ marketplaceAccountId?: string | null; sellerId?: string | null; reason: string }} input
 */
async function lookupAccounts(supabase, input) {
  const q = supabase
    .from("marketplace_accounts")
    .select("id,user_id,seller_company_id,external_seller_id,status,updated_at")
    .eq("marketplace", "mercado_livre")
    .neq("status", "removed")
    .order("updated_at", { ascending: false })
    .limit(8);
  if (input.marketplaceAccountId) q.eq("id", input.marketplaceAccountId);
  if (input.sellerId) q.eq("external_seller_id", input.sellerId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_ATTEMPT]", {
    stage: "processor",
    attempt: input.reason,
    query: {
      marketplace: "mercado_livre",
      status: "not_removed",
      marketplace_account_id: input.marketplaceAccountId ?? null,
      external_seller_id: input.sellerId ?? null,
      order: "updated_at_desc",
      limit: 8,
    },
    matches_found_count: rows.length,
    candidate_marketplace_accounts: rows,
  });
  return rows;
}

/**
 * @param {Record<string, unknown>} event
 */
function shouldIgnoreEvent(event) {
  const userId = event.user_id != null ? String(event.user_id).trim() : "";
  const resource = event.resource != null ? String(event.resource).trim() : "";
  const topic = event.topic != null ? String(event.topic).trim().toLowerCase() : "";
  const marketplaceAccountId =
    event.marketplace_account_id != null ? String(event.marketplace_account_id).trim() : "";
  const orderId = extractOrderId(resource);

  if (userId.toUpperCase() === "TEST" && resource === "/orders/123456") {
    return { ignore: true, reason: "TEST_EVENT_PLACEHOLDER" };
  }
  if (!topic) {
    return { ignore: true, reason: "MISSING_TOPIC" };
  }
  if (!resource) {
    return { ignore: true, reason: "MISSING_RESOURCE" };
  }
  if (topic === "orders_v2" && (!orderId || !/^\d+$/.test(orderId))) {
    return { ignore: true, reason: "INVALID_ORDER_ID" };
  }
  if (topic === "orders_v2" && !marketplaceAccountId && userId.toUpperCase() === "TEST") {
    return { ignore: true, reason: "MISSING_MARKETPLACE_ACCOUNT_FOR_TEST" };
  }

  return { ignore: false, reason: null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event
 */
async function resolveEventContext(supabase, event) {
  const marketplaceAccountId =
    event.marketplace_account_id != null ? String(event.marketplace_account_id) : null;
  const directUserId = event.user_id != null ? String(event.user_id) : null;
  const sellerCompanyId =
    event.seller_company_id != null && String(event.seller_company_id).trim() !== ""
      ? String(event.seller_company_id)
      : null;
  const applicationId =
    event.application_id != null && String(event.application_id).trim() !== ""
      ? String(event.application_id)
      : null;
  const topic = event.topic != null ? String(event.topic).trim().toLowerCase() : null;
  const resource = event.resource != null ? String(event.resource).trim() : null;
  const orderId = extractOrderId(resource);
  const sellerIdFromPayload =
    event.user_id != null && String(event.user_id).trim() !== "" ? String(event.user_id).trim() : null;
  const sellerIdFromResource = orderId;
  const marketplaceUserId =
    event.marketplace_user_id != null
      ? String(event.marketplace_user_id)
      : event.user_id != null
        ? String(event.user_id)
        : null;

  console.info("[WEBHOOK_CONTEXT_RESOLVE_START]", {
    stage: "processor",
    topic,
    resource,
    order_id: orderId,
    user_id: directUserId,
    application_id: applicationId,
    marketplace: "mercado_livre",
    marketplace_user_id: marketplaceUserId,
    marketplace_account_id: marketplaceAccountId,
    seller_company_id: sellerCompanyId,
    seller_id_from_payload: sellerIdFromPayload,
    seller_id_from_resource: sellerIdFromResource,
  });
  console.info("[WEBHOOK_CONTEXT_RESOLVE_PAYLOAD]", {
    stage: "processor",
    topic,
    resource,
    user_id: directUserId,
    application_id: applicationId,
    marketplace_user_id: marketplaceUserId,
    marketplace_account_id: marketplaceAccountId,
    seller_company_id: sellerCompanyId,
  });

  if (marketplaceAccountId && directUserId) {
    console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_FOUND]", {
      stage: "processor",
      attempt: "event_contains_marketplace_account_and_user",
      matches_found_count: 1,
      candidate_marketplace_accounts: [{ id: marketplaceAccountId, user_id: directUserId }],
    });
    return { userId: directUserId, marketplaceAccountId, sellerCompanyId };
  }

  if (marketplaceAccountId && !directUserId) {
    const rows = await lookupAccounts(supabase, {
      marketplaceAccountId,
      reason: "marketplace_account_id_only",
    });
    if (rows[0]?.user_id) {
      console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_FOUND]", {
        stage: "processor",
        attempt: "marketplace_account_id_only",
        matches_found_count: rows.length,
        candidate_marketplace_accounts: rows,
      });
      return {
        userId: String(rows[0].user_id),
        marketplaceAccountId: String(rows[0].id),
        sellerCompanyId: rows[0].seller_company_id != null ? String(rows[0].seller_company_id) : null,
      };
    }
  }

  if (marketplaceUserId) {
    const rows = await lookupAccounts(supabase, {
      sellerId: marketplaceUserId,
      reason: "external_seller_id_from_payload",
    });
    if (rows[0]?.id && rows[0]?.user_id) {
      console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_FOUND]", {
        stage: "processor",
        attempt: "external_seller_id_from_payload",
        matches_found_count: rows.length,
        candidate_marketplace_accounts: rows,
      });
      return {
        userId: String(rows[0].user_id),
        marketplaceAccountId: String(rows[0].id),
        sellerCompanyId: rows[0].seller_company_id != null ? String(rows[0].seller_company_id) : null,
      };
    }
  }
  if (orderId) {
    const fallbackCandidates = await lookupAccounts(supabase, {
      reason: "fallback_fetch_order_by_candidates",
    });
    for (const candidate of fallbackCandidates) {
      try {
        const candidateAccountId = String(candidate.id);
        const candidateUserId = String(candidate.user_id || "");
        if (!candidateUserId) continue;
        const token = await getValidMLToken(candidateUserId, { marketplaceAccountId: candidateAccountId });
        console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_ATTEMPT]", {
          stage: "processor",
          attempt: "fetch_order_full_for_seller_fallback",
          marketplace_account_id: candidateAccountId,
          user_id: candidateUserId,
          order_id: orderId,
        });
        const order = await fetchOrderById(token, orderId);
        const sellerIdFromOrder = pickSellerIdFromOrder(order);
        const packId = pickPackIdFromOrder(order);
        if (!sellerIdFromOrder) continue;
        const orderSellerRows = await lookupAccounts(supabase, {
          sellerId: sellerIdFromOrder,
          reason: "external_seller_id_from_order_seller",
        });
        if (orderSellerRows[0]?.id && orderSellerRows[0]?.user_id) {
          console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_FOUND]", {
            stage: "processor",
            attempt: "external_seller_id_from_order_seller",
            order_id: orderId,
            seller_id_from_order: sellerIdFromOrder,
            pack_id: packId,
            matches_found_count: orderSellerRows.length,
            candidate_marketplace_accounts: orderSellerRows,
          });
          return {
            userId: String(orderSellerRows[0].user_id),
            marketplaceAccountId: String(orderSellerRows[0].id),
            sellerCompanyId:
              orderSellerRows[0].seller_company_id != null ? String(orderSellerRows[0].seller_company_id) : null,
            sellerIdFromOrder,
            packId,
          };
        }
      } catch (e) {
        console.warn("[WEBHOOK_CONTEXT_RESOLVE_MATCH_ATTEMPT]", {
          stage: "processor",
          attempt: "fetch_order_full_for_seller_fallback",
          order_id: orderId,
          marketplace_account_id: candidate.id ?? null,
          user_id: candidate.user_id ?? null,
          message: e?.message ? String(e.message) : String(e),
        });
      }
    }
  }
  console.warn("[WEBHOOK_CONTEXT_RESOLVE_NOT_FOUND]", {
    stage: "processor",
    topic,
    resource,
    order_id: orderId,
    user_id: directUserId,
    application_id: applicationId,
    marketplace: "mercado_livre",
    marketplace_user_id: marketplaceUserId,
    marketplace_account_id: marketplaceAccountId,
    seller_company_id: sellerCompanyId,
    seller_id_from_payload: sellerIdFromPayload,
    seller_id_from_resource: sellerIdFromResource,
    matches_found_count: 0,
    candidate_marketplace_accounts: [],
  });
  const err = new Error("WEBHOOK_ACCOUNT_CONTEXT_NOT_FOUND");
  /** @type {any} */ (err).code = "WEBHOOK_ACCOUNT_CONTEXT_NOT_FOUND";
  throw err;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event
 */
async function processOrderEvent(supabase, event, resolvedContext = null) {
  const resource = event.resource != null ? String(event.resource) : null;
  const orderId = extractOrderId(resource);
  if (!orderId) {
    throw new Error("INVALID_ORDER_ID");
  }

  const { userId, marketplaceAccountId } =
    resolvedContext != null ? resolvedContext : await resolveEventContext(supabase, event);
  const { data: account } = await supabase
    .from("marketplace_accounts")
    .select("seller_company_id")
    .eq("id", marketplaceAccountId)
    .maybeSingle();
  const sellerCompanyId =
    account?.seller_company_id != null ? String(account.seller_company_id) : null;
  const accessToken = await getValidMLToken(userId, { marketplaceAccountId });
  console.info("[ml-webhook-events-job] order_fetch_start", {
    event_id: event.id ?? null,
    order_id: orderId,
    topic: String(event.topic || "").toLowerCase(),
    marketplace_account_id: marketplaceAccountId,
    user_id: userId,
  });
  const order = await fetchOrderById(accessToken, orderId, { marketplaceAccountId });
  const orderForPersist = await enrichMlOrderBuyerThumbnailIfNeeded(order, accessToken, { marketplaceAccountId });
  const sellerIdFromOrder = pickSellerIdFromOrder(orderForPersist);
  const packId = pickPackIdFromOrder(orderForPersist);
  const shipping =
    orderForPersist?.shipping && typeof orderForPersist.shipping === "object" ? orderForPersist.shipping : null;
  console.info("[ML_WEBHOOK_PROCESS_ORDER_FETCH_DONE]", {
    order_id: orderId,
    status: orderForPersist?.status ?? null,
    date_created: orderForPersist?.date_created ?? null,
    marketplace_account_id: marketplaceAccountId,
    seller_id_from_order: sellerIdFromOrder,
    pack_id: packId,
    shipping_mode: shipping?.mode ?? null,
    logistic_type: shipping?.logistic_type ?? null,
    shipping_status: shipping?.status ?? null,
    shipment_id: shipping?.id ?? orderForPersist?.shipment_id ?? null,
  });
  const summaryStub = {
    synced_count: 0,
    created_count: 0,
    updated_count: 0,
    skipped_count: 0,
    skipped_cancelled_or_unavailable_count: 0,
    errors: [],
  };
  await applyMlOrderDetailToMarketplaceSales(
    supabase,
    userId,
    marketplaceAccountId,
    sellerCompanyId,
    orderForPersist,
    new Date().toISOString(),
    summaryStub,
    accessToken,
    { syncRunId: `webhook:${event.id ?? "unknown"}`, orderIndex: null, total: null, syncType: "ml_webhook_orders_v2" },
    { syncType: "ml_webhook_orders_v2" }
  );
  console.info("[ml-webhook-events-job] order_persist_ok", {
    event_id: event.id ?? null,
    order_id: orderId,
    marketplace_account_id: marketplaceAccountId,
    user_id: userId,
  });
  console.info("[ML_WEBHOOK_PROCESS_ORDER_UPSERT_DONE]", {
    order_id: orderId,
    marketplace_account_id: marketplaceAccountId,
    user_id: userId,
  });
}

/**
 * Prepara o ponto único para job assíncrono.
 * Suporta assinatura antiga `runMlWebhookProcessor(10)` e nova por objeto.
 *
 * @param {number | { batchSize?: number; maxAttempts?: number }} [input]
 */
export async function runMlWebhookProcessor(input = {}) {
  const supabase = getSupabaseAdmin();

  const batchSize =
    typeof input === "number"
      ? Math.max(1, Math.min(500, input))
      : Math.max(1, Math.min(500, parseInt(String(input.batchSize ?? "20"), 10) || 20));
  const maxAttempts =
    typeof input === "number"
      ? Math.max(1, parseInt(process.env.ML_WEBHOOK_EVENTS_MAX_ATTEMPTS || "5", 10) || 5)
      : Math.max(
          1,
          parseInt(
            String(input.maxAttempts ?? process.env.ML_WEBHOOK_EVENTS_MAX_ATTEMPTS ?? "5"),
            10
          ) || 5
        );

  const budgetMs = resolveMlWebhookEventsBudgetMs();
  const drainStartedAt = Date.now();
  const deadlineMs = drainStartedAt + budgetMs;

  console.info("[ml-webhook-events-job] drain_start", {
    batch_size: batchSize,
    max_attempts: maxAttempts,
    budget_ms: budgetMs,
    active_runtime: "ml_webhook_events_processor",
    build_fingerprint: {
      vercel_git_commit: process.env.VERCEL_GIT_COMMIT ?? null,
      vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    },
  });
  console.info("[ML_PROCESSOR_START]", { batchSize, maxAttempts, budget_ms: budgetMs });

  const reclaimed = await reclaimStaleMlWebhookProcessingEvents(supabase);
  if (reclaimed > 0) {
    console.warn("[ml-webhook-events-job] stale_processing_reclaimed_total", { reclaimed });
  }

  let rows = [];
  try {
    rows = await fetchPendingMlWebhookEvents(supabase, batchSize);
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    console.error("[ML_PROCESSOR_FETCH_ERROR]", { message });
    return { processed: 0, error: message, results: [], reclaimed_stale_processing: reclaimed };
  }

  console.info("[ML_PROCESSOR_FETCHED_EVENTS]", {
    found: rows.length,
    status_filter: "pending",
    priority: "orders_v2_first",
    order_by: "created_at_asc",
    limit: batchSize,
  });
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let doneCount = 0;
  let ignoredCount = 0;
  let failedCount = 0;
  let budgetStopped = false;

  for (const event of rows) {
    if (Date.now() >= deadlineMs) {
      budgetStopped = true;
      break;
    }
    const eventId = event.id != null ? String(event.id) : "";
    const topic = event.topic != null ? String(event.topic) : "";
    const topicLower = topic.trim().toLowerCase();
    const resource = event.resource != null ? String(event.resource) : null;
    const orderId = extractOrderId(resource);
    const shipmentId = inferShipmentIdFromMlWebhook(topicLower, resource);

    try {
      console.info("[ml-webhook-events-job] event_processing_start", {
        event_id: eventId,
        topic: topicLower || null,
        resource,
        order_id: orderId,
        shipment_id: shipmentId,
        marketplace_account_id: event.marketplace_account_id ?? null,
        ml_user_id: event.user_id ?? event.marketplace_user_id ?? null,
      });

      const ignoreCheck = shouldIgnoreEvent(/** @type {Record<string, unknown>} */ (event));
      if (ignoreCheck.ignore) {
        const completedAt = new Date().toISOString();
        await updateWebhookEventRow(supabase, eventId, {
          status: "ignored",
          processed_at: completedAt,
          completed_at: completedAt,
          error_message: String(ignoreCheck.reason || "IGNORED"),
        });

        ignoredCount += 1;
        console.warn("[ml-webhook-events-job] event_failed", {
          event_id: eventId,
          topic: topicLower || null,
          resource,
          reason: ignoreCheck.reason,
          status: "ignored",
        });
        results.push({ id: eventId, status: "ignored", reason: ignoreCheck.reason });
        continue;
      }

      const processingStartedAt = new Date().toISOString();
      await updateWebhookEventRow(supabase, eventId, {
        status: "processing",
        started_at: processingStartedAt,
        error_message: null,
        last_error_code: null,
        last_error_message: null,
      });

      if (topicLower === "orders_v2") {
        const ctx = await resolveEventContext(supabase, /** @type {Record<string, unknown>} */ (event));
        await updateWebhookEventRow(supabase, eventId, {
          marketplace_account_id: ctx.marketplaceAccountId,
          seller_company_id: ctx.sellerCompanyId ?? null,
          user_id: ctx.userId,
        });
        await processOrderEvent(supabase, /** @type {Record<string, unknown>} */ (event), ctx);
      } else {
        const completedAt = new Date().toISOString();
        await updateWebhookEventRow(supabase, eventId, {
          status: "ignored",
          processed_at: completedAt,
          completed_at: completedAt,
          error_message: "unsupported_topic",
        });

        ignoredCount += 1;
        results.push({ id: eventId, status: "ignored", reason: "unsupported_topic" });
        continue;
      }

      const completedAt = new Date().toISOString();
      await updateWebhookEventRow(supabase, eventId, {
        status: "done",
        processed_at: completedAt,
        completed_at: completedAt,
        error_message: null,
      });

      doneCount += 1;
      console.info("[ml-webhook-events-job] event_completed", {
        event_id: eventId,
        topic: topicLower || null,
        order_id: orderId,
        marketplace_account_id: event.marketplace_account_id ?? null,
      });
      results.push({ id: eventId, status: "done" });
    } catch (err) {
      const attempts = (event.attempts != null ? Number(event.attempts) : 0) + 1;
      const message = err?.message ? String(err.message) : String(err);
      const code =
        err && typeof err === "object" && "code" in err && err.code != null
          ? String(/** @type {{ code?: unknown }} */ (err).code)
          : "WEBHOOK_PROCESS_ERROR";
      const nextStatus = attempts >= maxAttempts ? "error" : "pending";
      const completedAt = nextStatus === "error" ? new Date().toISOString() : null;

      failedCount += 1;
      console.error("[ml-webhook-events-job] event_failed", {
        event_id: eventId,
        topic: topicLower || null,
        resource,
        order_id: orderId,
        message,
        attempts,
        next_status: nextStatus,
      });
      if (message.includes("WEBHOOK_ACCOUNT_CONTEXT_NOT_FOUND")) {
        console.error("[WEBHOOK_CONTEXT_RESOLVE_FAILED]", {
          stage: "processor",
          event_id: eventId,
          topic: topicLower || null,
          resource,
          user_id: event.user_id ?? null,
          application_id: event.application_id ?? null,
          marketplace_user_id: event.marketplace_user_id ?? null,
          marketplace_account_id: event.marketplace_account_id ?? null,
          order_id: orderId,
          message,
        });
      }

      await updateWebhookEventRow(supabase, eventId, {
        status: nextStatus,
        attempts,
        error_message: message.slice(0, 4000),
        last_error_code: code.slice(0, 120),
        last_error_message: message.slice(0, 4000),
        processed_at: completedAt,
        completed_at: completedAt,
      });

      results.push({ id: eventId, status: nextStatus, error: message });
    }
  }

  const summary = {
    fetched: rows.length,
    processed_results: results.length,
    done: doneCount,
    ignored: ignoredCount,
    failed: failedCount,
    reclaimed_stale_processing: reclaimed,
    budget_stopped: budgetStopped,
    elapsed_ms: Date.now() - drainStartedAt,
    budget_ms: budgetMs,
  };
  console.info("[ml-webhook-events-job] drain_summary", summary);
  console.info("[ML_PROCESSOR_END]", summary);
  return {
    processed: results.length,
    results,
    ...summary,
  };
}

/**
 * Reprocessa pendências de orders_v2 em DEV (safe helper).
 * @param {{ limit?: number }} [input]
 */
export async function reprocessPendingOrdersV2(input = {}) {
  const supabase = getSupabaseAdmin();
  const limit = Math.max(1, Math.min(5000, parseInt(String(input.limit ?? "2000"), 10) || 2000));
  const { data: rows, error: pickErr } = await supabase
    .from("ml_webhook_events")
    .select("id")
    .eq("topic", "orders_v2")
    .in("status", ["pending", "error"])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (pickErr) throw pickErr;
  const ids = (Array.isArray(rows) ? rows : []).map((r) => String(r.id || "")).filter(Boolean);
  if (ids.length === 0) {
    return { ok: true, affected: 0 };
  }
  const { error } = await supabase
    .from("ml_webhook_events")
    .update({
      status: "pending",
      attempts: 0,
      error_message: null,
      last_error_code: null,
      last_error_message: null,
      processed_at: null,
    })
    .in("id", ids);
  if (error) throw error;
  console.info("[ML_WEBHOOK_REPROCESS_PENDING_ORDERS_V2]", {
    requested_limit: limit,
    affected_rows: ids.length,
  });
  return { ok: true, affected: ids.length };
}

