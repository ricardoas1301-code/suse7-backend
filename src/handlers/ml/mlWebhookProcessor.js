// =====================================================
// S7 ML WEBHOOK PROCESSOR
// Responsável por processar eventos pendentes do ML (orders_v2)
// =====================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { fetchOrderById } from "./_helpers/mercadoLibreOrdersApi.js";
import { persistMercadoLibreOrder } from "./_helpers/mlSalesPersist.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { inferOrderIdFromMlWebhook } from "./_helpers/mlWebhookPayload.js";

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
  const marketplaceUserId =
    event.marketplace_user_id != null
      ? String(event.marketplace_user_id)
      : event.user_id != null
        ? String(event.user_id)
        : null;

  if (marketplaceAccountId && directUserId) {
    return { userId: directUserId, marketplaceAccountId };
  }

  if (marketplaceAccountId && !directUserId) {
    const { data } = await supabase
      .from("marketplace_accounts")
      .select("user_id")
      .eq("id", marketplaceAccountId)
      .maybeSingle();
    if (data?.user_id) {
      return { userId: String(data.user_id), marketplaceAccountId };
    }
  }

  if (marketplaceUserId) {
    const { data } = await supabase
      .from("marketplace_accounts")
      .select("id, user_id")
      .eq("marketplace", "mercado_livre")
      .eq("external_seller_id", marketplaceUserId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.id && data?.user_id) {
      return {
        userId: String(data.user_id),
        marketplaceAccountId: String(data.id),
      };
    }
  }

  throw new Error("WEBHOOK_ACCOUNT_CONTEXT_NOT_FOUND");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event
 */
async function processOrderEvent(supabase, event) {
  const resource = event.resource != null ? String(event.resource) : null;
  const orderId = extractOrderId(resource);
  if (!orderId) {
    throw new Error("INVALID_ORDER_ID");
  }

  const { userId, marketplaceAccountId } = await resolveEventContext(supabase, event);
  const accessToken = await getValidMLToken(userId, { marketplaceAccountId });
  const order = await fetchOrderById(accessToken, orderId);
  await persistMercadoLibreOrder(supabase, userId, order, {
    marketplace: "mercado_livre",
    log: (msg, extra) => {
      console.info("[ML_PROCESSOR_ORDER_PERSIST]", {
        message: msg,
        order_id: orderId,
        ...extra,
      });
    },
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

  console.info("[ML_PROCESSOR_START]", { batchSize, maxAttempts });

  const { data: events, error } = await supabase
    .from("ml_webhook_events")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    console.error("[ML_PROCESSOR_FETCH_ERROR]", { message: error.message });
    return { processed: 0, error: error.message, results: [] };
  }

  const rows = events ?? [];
  console.info("[ML_PROCESSOR_FETCHED_EVENTS]", {
    found: rows.length,
    status_filter: "pending",
    order_by: "created_at_asc",
    limit: batchSize,
  });
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const event of rows) {
    const eventId = event.id != null ? String(event.id) : "";
    const topic = event.topic != null ? String(event.topic) : "";
    const resource = event.resource != null ? String(event.resource) : null;

    try {
      console.info("[ML_PROCESSING_EVENT]", { id: eventId, topic, resource });

      const ignoreCheck = shouldIgnoreEvent(/** @type {Record<string, unknown>} */ (event));
      if (ignoreCheck.ignore) {
        await supabase
          .from("ml_webhook_events")
          .update({
            status: "ignored",
            processed_at: new Date().toISOString(),
            error_message: String(ignoreCheck.reason || "IGNORED"),
          })
          .eq("id", eventId);

        console.warn("[ML_EVENT_IGNORED]", {
          event_id: eventId,
          topic,
          resource,
          user_id: event.user_id ?? null,
          marketplace_account_id: event.marketplace_account_id ?? null,
          attempts: event.attempts ?? 0,
          reason: ignoreCheck.reason,
          status: "ignored",
        });
        results.push({ id: eventId, status: "ignored", reason: ignoreCheck.reason });
        continue;
      }

      await supabase
        .from("ml_webhook_events")
        .update({
          status: "processing",
          error_message: null,
        })
        .eq("id", eventId);

      if (topic.toLowerCase() === "orders_v2") {
        await processOrderEvent(supabase, /** @type {Record<string, unknown>} */ (event));
      }

      await supabase
        .from("ml_webhook_events")
        .update({
          status: "done",
          processed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", eventId);

      console.info("[ML_EVENT_DONE]", { id: eventId, topic });
      results.push({ id: eventId, status: "done" });
    } catch (err) {
      const attempts = (event.attempts != null ? Number(event.attempts) : 0) + 1;
      const message = err?.message ? String(err.message) : String(err);
      const nextStatus = attempts >= maxAttempts ? "error" : "pending";

      console.error("[ML_EVENT_ERROR]", { id: eventId, message, attempts, nextStatus });

      await supabase
        .from("ml_webhook_events")
        .update({
          status: nextStatus,
          attempts,
          error_message: message.slice(0, 4000),
          processed_at: nextStatus === "error" ? new Date().toISOString() : null,
        })
        .eq("id", eventId);

      results.push({ id: eventId, status: nextStatus, error: message });
    }
  }

  console.info("[ML_PROCESSOR_END]", { processed: rows.length });
  return {
    processed: rows.length,
    results,
  };
}

