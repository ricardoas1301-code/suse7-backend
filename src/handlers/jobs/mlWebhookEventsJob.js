// ======================================================================
// POST /api/jobs/ml-webhook-events — processa ml_webhook_events pendentes
// Proteção: X-Job-Secret === 
// Env: ML_WEBHOOK_EVENTS_BATCH_SIZE (default 100), ML_WEBHOOK_EVENTS_MAX_ATTEMPTS (default 5)
// ======================================================================

import { config } from "../../infra/config.js";
import { runMlWebhookProcessor } from "../ml/mlWebhookProcessor.js";

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export async function handleJobsMlWebhookEvents(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const jobSecret = config.jobSecret;
  if (jobSecret && req.headers["x-job-secret"] !== jobSecret) {
    return res.status(401).json({ ok: false, error: "Token de job inválido" });
  }

  const defaultBatchSize = 20;
  const defaultMaxAttempts = 5;
  const batchSize = Math.min(
    500,
    Math.max(1, parseInt(process.env.ML_WEBHOOK_EVENTS_BATCH_SIZE || String(defaultBatchSize), 10) || defaultBatchSize)
  );
  const maxAttempts = Math.min(
    50,
    Math.max(1, parseInt(process.env.ML_WEBHOOK_EVENTS_MAX_ATTEMPTS || String(defaultMaxAttempts), 10) || defaultMaxAttempts)
  );

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const inputLimit = parseInt(
    String(body.limit ?? req.query?.limit ?? body.batchSize ?? req.query?.batchSize ?? batchSize),
    10
  );
  const effectiveLimit = Number.isFinite(inputLimit) ? Math.max(1, Math.min(500, inputLimit)) : batchSize;

  console.info("[ML_WEBHOOK_JOB_START]", {
    timestamp: new Date().toISOString(),
    limit: effectiveLimit,
    maxAttempts,
  });

  try {
    const out = await runMlWebhookProcessor({ batchSize: effectiveLimit, maxAttempts });
    console.info("[ML_WEBHOOK_JOB_END]", {
      timestamp: new Date().toISOString(),
      limit: effectiveLimit,
      processed: out?.processed ?? 0,
    });
    return res.status(200).json({
      ok: true,
      batch_size: effectiveLimit,
      max_attempts: maxAttempts,
      ...out,
    });
  } catch (e) {
    console.error("[jobs/ml-webhook-events] fatal", e);
    console.error("[ML_WEBHOOK_JOB_END]", {
      timestamp: new Date().toISOString(),
      limit: effectiveLimit,
      error: e?.message ? String(e.message) : "unknown_error",
    });
    return res.status(500).json({
      ok: false,
      error: e?.message ? String(e.message) : "Falha no processamento de eventos ML",
    });
  }
}
