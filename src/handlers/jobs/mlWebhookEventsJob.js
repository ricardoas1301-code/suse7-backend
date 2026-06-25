// ======================================================================
// POST /api/jobs/ml-webhook-events — processa ml_webhook_events pendentes
// Proteção: X-Job-Secret === 
// Env: ML_WEBHOOK_EVENTS_BATCH_SIZE (default 100), ML_WEBHOOK_EVENTS_MAX_ATTEMPTS (default 5)
// ======================================================================

import { config } from "../../infra/config.js";
import { reprocessPendingOrdersV2, runMlWebhookProcessor } from "../ml/mlWebhookProcessor.js";

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export async function handleJobsMlWebhookEvents(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const jobSecret = config.jobSecret;
  const cronSecret = config.cronSecret;
  const headerSecret = req.headers["x-job-secret"] != null ? String(req.headers["x-job-secret"]) : "";
  const authHeader = req.headers.authorization != null ? String(req.headers.authorization) : "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const hasValidJobSecret = jobSecret ? headerSecret === jobSecret : false;
  const hasValidCronSecret = cronSecret ? bearer === cronSecret : false;
  const authOk = jobSecret || cronSecret ? hasValidJobSecret || hasValidCronSecret : true;
  if (!authOk) {
    console.warn("[ML_WEBHOOK_JOB_AUTH_FAILED]", {
      method: req.method,
      has_job_secret_configured: Boolean(jobSecret),
      has_cron_secret_configured: Boolean(cronSecret),
      provided_job_header: headerSecret ? "present" : "missing",
      provided_bearer: bearer ? "present" : "missing",
      build_fingerprint: {
        vercel_git_commit: process.env.VERCEL_GIT_COMMIT ?? null,
        vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      },
    });
    return res.status(401).json({ ok: false, error: "Token de job inválido" });
  }

  const defaultBatchSize = 10;
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
  const reprocessRequested =
    String(body.reprocess_orders_v2 ?? req.query?.reprocess_orders_v2 ?? "").trim().toLowerCase() === "true" ||
    String(body.reprocess_orders_v2 ?? req.query?.reprocess_orders_v2 ?? "").trim() === "1";

  console.info("[ml-webhook-events-job] drain_start", {
    timestamp: new Date().toISOString(),
    limit: effectiveLimit,
    maxAttempts,
    method: req.method,
    reprocess_orders_v2: reprocessRequested,
    auth_mode:
      jobSecret || cronSecret
        ? hasValidCronSecret
          ? "cron-secret-bearer"
          : "x-job-secret"
        : "open-no-secret",
    build_fingerprint: {
      vercel_git_commit: process.env.VERCEL_GIT_COMMIT ?? null,
      vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    },
  });

  try {
    let reprocess = null;
    if (reprocessRequested) {
      reprocess = await reprocessPendingOrdersV2({ limit: 5000 });
    }
    const out = await runMlWebhookProcessor({ batchSize: effectiveLimit, maxAttempts });
    console.info("[ml-webhook-events-job] drain_summary", {
      timestamp: new Date().toISOString(),
      limit: effectiveLimit,
      processed: out?.processed ?? 0,
      done: out?.done ?? null,
      ignored: out?.ignored ?? null,
      failed: out?.failed ?? null,
      budget_stopped: out?.budget_stopped ?? null,
      elapsed_ms: out?.elapsed_ms ?? null,
    });
    return res.status(200).json({
      ok: true,
      batch_size: effectiveLimit,
      max_attempts: maxAttempts,
      reprocess_orders_v2: reprocess,
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
