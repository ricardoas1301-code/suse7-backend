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
  const validation = validateMinimumPayload(input.payload);
  if (!validation.ok) {
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

  const ip = extractRequestIp(input.req);
  return saveMlWebhookEvent(input.payload, {
    ip,
    marketplace: input.marketplace || "mercado_livre",
  });
}

