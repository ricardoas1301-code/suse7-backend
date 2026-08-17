import { waitUntil } from "@vercel/functions";
import { readRequestBodyBuffer } from "../../infra/readRequestBodyBuffer.js";
import { config } from "../../infra/config.js";
import { receiveMlWebhook } from "./mlWebhookService.js";
import { inferOrderIdFromMlWebhook, inferShipmentIdFromMlWebhook } from "./_helpers/mlWebhookPayload.js";

const ACK_TIMING_ENABLED =
  String(process.env.ML_WEBHOOK_ACK_TIMING || "1").trim() === "1" ||
  String(process.env.ML_WEBHOOK_ACK_TIMING || "").trim() === "true";

/**
 * @param {number} startMs
 * @param {number} endMs
 */
function stageMs(startMs, endMs) {
  return Math.max(0, endMs - startMs);
}

/**
 * Dispara job assíncrono preservado pelo runtime (Vercel waitUntil) ou fallback local.
 *
 * @param {string} dispatchUrl
 * @param {Record<string, string>} headers
 * @param {string | null} eventId
 */
function scheduleMlWebhookJobDispatch(dispatchUrl, headers, eventId) {
  const body = JSON.stringify({
    limit: 8,
    priority_event_ids: eventId ? [eventId] : [],
  });

  const run = async () => {
    const startedAt = Date.now();
    const r = await fetch(dispatchUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });
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
      priority_event_id: eventId,
      job_processed: jobBody.processed ?? null,
      job_done: jobBody.done ?? null,
      job_failed: jobBody.failed ?? null,
      job_budget_stopped: jobBody.budget_stopped ?? null,
      job_error: jobBody.error ?? null,
    });
  };

  try {
    waitUntil(run());
  } catch {
    Promise.resolve(run()).catch((dispatchErr) => {
      console.error("[ML_WEBHOOK_JOB_DISPATCHED]", {
        source: "/api/ml/webhook",
        ok: false,
        error: dispatchErr?.message ?? String(dispatchErr),
      });
    });
  }
}

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

  const t0Ms = Date.now();
  let tParseDoneMs = t0Ms;

  let payload = /** @type {unknown} */ ({});
  try {
    const bodyBuffer = await readRequestBodyBuffer(req);
    tParseDoneMs = Date.now();
    const raw = bodyBuffer.length > 0 ? bodyBuffer.toString("utf8") : "";
    if (raw.trim() !== "") {
      payload = JSON.parse(raw);
    } else if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      payload = req.body;
    }
  } catch (e) {
    tParseDoneMs = Date.now();
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

    const tDbStartMs = Date.now();
    const result = await receiveMlWebhook({
      payload,
      req,
      marketplace: "mercado_livre",
    });
    const repoTiming = result?.timing && typeof result.timing === "object" ? result.timing : {};
    const tDbDoneMs =
      typeof repoTiming.db_done_ms === "number"
        ? repoTiming.db_done_ms
        : typeof repoTiming.dedupe_done_ms === "number"
          ? repoTiming.dedupe_done_ms
          : Date.now();

    let tTriggerStartMs = null;
    let tTriggerDoneMs = null;

    if (result.saved && String(result.status || "").toLowerCase() !== "ignored") {
      const host = req.headers?.host != null ? String(req.headers.host) : "";
      const protoHeader = req.headers?.["x-forwarded-proto"] != null ? String(req.headers["x-forwarded-proto"]) : "";
      const proto = protoHeader.includes("https") ? "https" : "http";
      const baseUrl = host ? `${proto}://${host}` : null;
      const dispatchUrl = baseUrl ? `${baseUrl}/api/jobs/ml-webhook-events` : null;
      if (dispatchUrl) {
        tTriggerStartMs = Date.now();
        const headers = {};
        if (config.jobSecret) headers["x-job-secret"] = config.jobSecret;
        scheduleMlWebhookJobDispatch(dispatchUrl, headers, result.id ? String(result.id) : null);
        tTriggerDoneMs = Date.now();
      }
    }

    const tResponseMs = Date.now();
    const ackTiming = {
      T0_entry_ms: 0,
      parse_ms: stageMs(t0Ms, tParseDoneMs),
      validate_and_persist_ms: stageMs(tDbStartMs, tDbDoneMs),
      trigger_schedule_ms:
        tTriggerStartMs != null && tTriggerDoneMs != null ? stageMs(tTriggerStartMs, tTriggerDoneMs) : 0,
      total_ack_ms: stageMs(t0Ms, tResponseMs),
      duplicate: Boolean(result.duplicate),
      event_id: result.id ?? null,
    };

    if (ACK_TIMING_ENABLED) {
      console.info("[ML_WEBHOOK_ACK_TIMING]", ackTiming);
    }

    /** @type {Record<string, unknown>} */
    const responseBody = {
      ok: true,
      accepted: true,
      duplicate: Boolean(result.duplicate),
      status: result.status || "pending",
    };
    if (ACK_TIMING_ENABLED) {
      responseBody.ack_timing_ms = ackTiming;
    }

    return res.status(200).json(responseBody);
  } catch (e) {
    console.error("[ML_WEBHOOK_ERROR]", {
      topic: null,
      resource: null,
      user_id: null,
      timestamp: new Date().toISOString(),
      message: e?.message ? String(e.message) : String(e),
      ack_ms: stageMs(t0Ms, Date.now()),
    });
    return res.status(200).json({
      ok: true,
      accepted: true,
      status: "error",
    });
  }
}
