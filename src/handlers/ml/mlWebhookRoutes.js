import { readRequestBodyBuffer } from "../../infra/readRequestBodyBuffer.js";
import { config } from "../../infra/config.js";
import { receiveMlWebhook } from "./mlWebhookService.js";
import { inferOrderIdFromMlWebhook, inferShipmentIdFromMlWebhook } from "./_helpers/mlWebhookPayload.js";

/**
 * @param {import("http").IncomingMessage & { bodyBuffer?: Buffer; body?: unknown }} req
 * @param {import("http").ServerResponse} res
 */
export default async function handleMlWebhookRoute(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ml/webhook",
      status: "ready",
      accepts: ["POST"],
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido", accepts: ["GET", "POST"] });
  }

  let payload = /** @type {unknown} */ ({});
  try {
    const bodyBuffer = await readRequestBodyBuffer(req);
    const raw = bodyBuffer.length > 0 ? bodyBuffer.toString("utf8") : "";
    if (raw.trim() !== "") {
      payload = JSON.parse(raw);
    } else if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      payload = req.body;
    }
  } catch (e) {
    payload = { _parse_error: true, _raw_hint: "invalid_json" };
    console.error("[ML_WEBHOOK_ERROR]", {
      message: e?.message ? String(e.message) : String(e),
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const maybeObj = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const pUserId =
      maybeObj?.user_id != null
        ? String(maybeObj.user_id)
        : maybeObj?.userId != null
          ? String(maybeObj.userId)
          : null;
    const pTopic = maybeObj?.topic != null ? String(maybeObj.topic) : null;
    const pResource = maybeObj?.resource != null ? String(maybeObj.resource) : null;
    const orderId = inferOrderIdFromMlWebhook(pTopic, pResource);
    const shipmentId = inferShipmentIdFromMlWebhook(pTopic, pResource);
    const receivedAt = new Date().toISOString();
    console.info("[ml-webhook] event_received", {
      method: req.method,
      topic: pTopic,
      resource: pResource,
      user_id: pUserId,
      ml_user_id: pUserId,
      order_id: orderId,
      shipment_id: shipmentId,
      received_at: receivedAt,
    });
    console.info("[ML_WEBHOOK_ROUTE_HIT]", {
      method: req.method,
      topic: pTopic,
      resource: pResource,
      user_id: pUserId,
      order_id: orderId,
      shipment_id: shipmentId,
      received_at: receivedAt,
    });

    const result = await receiveMlWebhook({
      payload,
      req,
      marketplace: "mercado_livre",
    });

    const logMeta = {
      topic: result.topic,
      resource: result.resource,
      user_id: result.user_id,
      timestamp: new Date().toISOString(),
    };

    console.info("[ML_WEBHOOK_RECEIVED]", logMeta);
    if (result.saved) {
      console.info("[ml-webhook] event_queued", {
        topic: result.topic,
        resource: result.resource,
        user_id: result.user_id,
        ml_user_id: result.user_id,
        order_id: inferOrderIdFromMlWebhook(result.topic, result.resource),
        shipment_id: inferShipmentIdFromMlWebhook(result.topic, result.resource),
        id: result.id || null,
        duplicate: Boolean(result.duplicate),
        status: result.status || "pending",
        received_at: receivedAt,
      });
      console.info("[ml/webhook] event_persisted", {
        ...logMeta,
        id: result.id || null,
        duplicate: Boolean(result.duplicate),
        status: result.status || "pending",
      });
      console.info("[ML_WEBHOOK_SAVED]", {
        ...logMeta,
        id: result.id || null,
        duplicate: Boolean(result.duplicate),
        status: result.status || "pending",
      });

      const host = req.headers?.host != null ? String(req.headers.host) : "";
      const protoHeader = req.headers?.["x-forwarded-proto"] != null ? String(req.headers["x-forwarded-proto"]) : "";
      const proto = protoHeader.includes("https") ? "https" : "http";
      const baseUrl = host ? `${proto}://${host}` : null;
      const dispatchUrl = baseUrl ? `${baseUrl}/api/jobs/ml-webhook-events?limit=8` : null;
      if (dispatchUrl) {
        const headers = {};
        if (config.jobSecret) headers["x-job-secret"] = config.jobSecret;
        Promise.resolve()
          .then(async () => {
            try {
              const startedAt = Date.now();
              const r = await fetch(dispatchUrl, { method: "POST", headers });
              const elapsedMs = Date.now() - startedAt;
              /** @type {Record<string, unknown>} */
              let jobBody = {};
              try {
                jobBody = await r.json();
              } catch {
                jobBody = {};
              }
              console.info("[ML_WEBHOOK_JOB_DISPATCHED]", {
                source: "/api/ml/webhook",
                status: r.status,
                ok: r.ok,
                elapsed_ms: elapsedMs,
                duplicate: Boolean(result.duplicate),
                job_processed: jobBody.processed ?? null,
                job_done: jobBody.done ?? null,
                job_failed: jobBody.failed ?? null,
                job_budget_stopped: jobBody.budget_stopped ?? null,
                job_error: jobBody.error ?? null,
              });
            } catch (dispatchErr) {
              console.error("[ML_WEBHOOK_JOB_DISPATCHED]", {
                source: "/api/ml/webhook",
                ok: false,
                error: dispatchErr?.message ?? String(dispatchErr),
              });
            }
          })
          .catch(() => {});
      }
    } else {
      console.error("[ML_WEBHOOK_ERROR]", {
        ...logMeta,
        reason: result.reason || "not_saved",
      });
    }

    return res.status(200).json({
      ok: true,
      accepted: true,
      duplicate: Boolean(result.duplicate),
      status: result.status || "pending",
    });
  } catch (e) {
    console.error("[ML_WEBHOOK_ERROR]", {
      topic: null,
      resource: null,
      user_id: null,
      timestamp: new Date().toISOString(),
      message: e?.message ? String(e.message) : String(e),
    });
    return res.status(200).json({
      ok: true,
      accepted: true,
      status: "error",
    });
  }
}

