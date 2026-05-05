// ======================================================
// Parse / dedupe de payloads do webhook Mercado Livre
// Formato típico: { _id, user_id, topic, resource, application_id, sent, ... }
// ======================================================

import { createHash } from "node:crypto";

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function asMlWebhookObject(payload) {
  if (payload != null && typeof payload === "object" && !Array.isArray(payload)) {
    return /** @type {Record<string, unknown>} */ (payload);
  }
  return {};
}

/**
 * Chave única para idempotência (não inventar contas; só evitar reprocessar o mesmo aviso).
 * @param {unknown} payload
 */
export function buildMlWebhookDedupeKey(payload) {
  const o = asMlWebhookObject(payload);
  const extId = o._id != null ? String(o._id).trim() : "";
  if (extId) {
    return `mlwh:${extId}`;
  }
  const topic = o.topic != null ? String(o.topic).trim() : "unknown";
  const resource = o.resource != null ? String(o.resource).trim() : "";
  const sent = o.sent != null ? String(o.sent).trim() : "";
  const raw = `${topic}|${resource}|${sent}`;
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  return `mlwh:hash:${hash.slice(0, 32)}`;
}

/**
 * @param {unknown} payload
 */
export function extractMlWebhookMeta(payload) {
  const o = asMlWebhookObject(payload);
  const topic = o.topic != null && String(o.topic).trim() !== "" ? String(o.topic).trim() : "unknown";
  const resource = o.resource != null && String(o.resource).trim() !== "" ? String(o.resource).trim() : null;
  const applicationId =
    o.application_id != null
      ? String(o.application_id).trim()
      : o.applicationId != null
        ? String(o.applicationId).trim()
        : null;
  const userRaw = o.user_id ?? o.seller_id ?? o.userId;
  const marketplaceUserId = userRaw != null && String(userRaw).trim() !== "" ? String(userRaw).trim() : null;
  const externalEventId = o._id != null ? String(o._id).trim() : null;
  return { topic, resource, applicationId, marketplaceUserId, externalEventId };
}

/**
 * Extrai o último segmento de path de `resource` (URL ou path).
 * @param {string | null | undefined} resource
 * @param {string} [kind] — "order" | "item" | "shipment" | "payment" | "claim" — heurística
 */
export function extractTrailingIdFromMlResource(resource, kind = "generic") {
  if (resource == null || String(resource).trim() === "") return null;
  const s = String(resource).trim();
  let path = s;
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      path = new URL(s).pathname;
    }
  } catch {
    path = s;
  }
  const parts = path.split("/").filter((p) => p && p.length > 0);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (kind === "order" && /^\d+$/.test(last)) return last;
  if (kind === "shipment" && /^\d+$/.test(last)) return last;
  if (kind === "item" && (last.startsWith("MLB") || last.startsWith("MLA") || last.length > 4)) return last;
  return last;
}

/**
 * @param {string} topic
 * @param {string | null} resource
 */
export function inferOrderIdFromMlWebhook(topic, resource) {
  const t = String(topic || "").toLowerCase();
  if (!t.includes("order")) return null;
  return extractTrailingIdFromMlResource(resource, "order");
}

/**
 * @param {string} topic
 * @param {string | null} resource
 */
export function inferItemIdFromMlWebhook(topic, resource) {
  const t = String(topic || "").toLowerCase();
  if (!t.includes("item")) return null;
  return extractTrailingIdFromMlResource(resource, "item");
}

/**
 * @param {string} topic
 * @param {string | null} resource
 */
export function inferShipmentIdFromMlWebhook(topic, resource) {
  const t = String(topic || "").toLowerCase();
  if (t !== "shipments" && !t.includes("shipment")) return null;
  return extractTrailingIdFromMlResource(resource, "shipment");
}
