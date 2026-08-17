import { asMlWebhookObject } from "./_helpers/mlWebhookPayload.js";
import { saveMlWebhookEvent } from "./mlWebhookRepository.js";

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

  const ip = extractRequestIp(input.req);
  return saveMlWebhookEvent(input.payload, {
    ip,
    marketplace: input.marketplace || "mercado_livre",
  });
}

