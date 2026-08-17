import { asMlWebhookObject } from "./_helpers/mlWebhookPayload.js";
import { saveMlWebhookEvent, saveMlWebhookEventIgnored } from "./mlWebhookRepository.js";
import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";

/**
 * @returns {import("@supabase/supabase-js").SupabaseClient}
 */
function getSupabaseAdmin() {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * @param {string | null | undefined} marketplaceUserId
 */
async function isOrphanMarketplaceSeller(marketplaceUserId) {
  const sellerId = marketplaceUserId != null ? String(marketplaceUserId).trim() : "";
  if (!sellerId || sellerId.toUpperCase() === "TEST") return false;

  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("marketplace_accounts")
    .select("id", { count: "exact", head: true })
    .eq("marketplace", "mercado_livre")
    .eq("external_seller_id", sellerId)
    .neq("status", "removed");

  if (error) throw error;
  return (count ?? 0) === 0;
}

/**
 * @param {import("http").IncomingMessage} req
 */
function extractRequestIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim() !== "") {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xrip = req.headers?.["x-real-ip"];
  if (typeof xrip === "string" && xrip.trim() !== "") {
    return xrip.trim();
  }
  const fromReqIp = /** @type {{ ip?: string }} */ (req).ip;
  if (typeof fromReqIp === "string" && fromReqIp.trim() !== "") return fromReqIp.trim();
  const fromSocket = req.socket?.remoteAddress;
  return fromSocket ? String(fromSocket) : null;
}

/**
 * @param {unknown} payload
 */
function validateMinimumPayload(payload) {
  const o = asMlWebhookObject(payload);
  const topic = o.topic != null ? String(o.topic).trim() : "";
  const resource = o.resource != null ? String(o.resource).trim() : "";
  if (!topic || !resource) {
    return {
      ok: false,
      reason: "missing_topic_or_resource",
    };
  }
  return { ok: true, reason: null };
}

/**
 * @param {{ payload: unknown; req: import("http").IncomingMessage; marketplace?: string }} input
 */
export async function receiveMlWebhook(input) {
  const payloadObj = asMlWebhookObject(input.payload);
  const receivedTopic =
    payloadObj.topic != null && String(payloadObj.topic).trim() !== ""
      ? String(payloadObj.topic).trim().toLowerCase()
      : null;
  console.info("[ML_WEBHOOK_TOPIC_RECEIVED]", {
    topic: receivedTopic,
    resource: payloadObj.resource != null ? String(payloadObj.resource) : null,
    user_id: payloadObj.user_id != null ? String(payloadObj.user_id) : null,
  });
  const validation = validateMinimumPayload(input.payload);
  if (!validation.ok) {
    console.warn("[ML_WEBHOOK_EVENT_SKIPPED]", {
      reason: validation.reason,
      topic: receivedTopic,
      resource: payloadObj.resource != null ? String(payloadObj.resource) : null,
    });
    return {
      ok: false,
      saved: false,
      status: "ignored_invalid_payload",
      duplicate: false,
      topic: null,
      resource: null,
      user_id: null,
      reason: validation.reason,
    };
  }

  if (receivedTopic === "orders_v2") {
    console.info("[ML_WEBHOOK_ORDERS_TRIGGER]", {
      topic: receivedTopic,
      resource: payloadObj.resource != null ? String(payloadObj.resource) : null,
    });
  } else {
    console.info("[ML_WEBHOOK_EVENT_SKIPPED]", {
      reason: "NON_ORDERS_TOPIC_AT_INGEST",
      topic: receivedTopic,
      resource: payloadObj.resource != null ? String(payloadObj.resource) : null,
    });
  }

  const marketplaceUserId =
    payloadObj.user_id != null
      ? String(payloadObj.user_id).trim()
      : payloadObj.userId != null
        ? String(payloadObj.userId).trim()
        : null;
  const ip = extractRequestIp(input.req);

  if (receivedTopic === "orders_v2" && marketplaceUserId) {
    const orphan = await isOrphanMarketplaceSeller(marketplaceUserId);
    if (orphan) {
      console.warn("[ML_WEBHOOK_ORPHAN_ACCOUNT]", {
        reason: "ignored_orphan_account",
        topic: receivedTopic,
        marketplace_user_id: marketplaceUserId,
        resource: payloadObj.resource != null ? String(payloadObj.resource) : null,
      });
      return saveMlWebhookEventIgnored(input.payload, {
        ip,
        marketplace: input.marketplace || "mercado_livre",
        reason: "ignored_orphan_account",
      });
    }
  }

  return saveMlWebhookEvent(input.payload, {
    ip,
    marketplace: input.marketplace || "mercado_livre",
  });
}

