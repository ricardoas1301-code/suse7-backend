import { readRequestBodyBuffer } from "../../infra/readRequestBodyBuffer.js";
import { receiveMlWebhook } from "./mlWebhookService.js";

/**
 * @param {import("http").IncomingMessage & { bodyBuffer?: Buffer; body?: unknown }} req
 * @param {import("http").ServerResponse} res
 */
export default async function handleMlWebhookRoute(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
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
      console.info("[ML_WEBHOOK_SAVED]", {
        ...logMeta,
        id: result.id || null,
        duplicate: Boolean(result.duplicate),
        status: result.status || "pending",
      });
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

