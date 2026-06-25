// ======================================================================
// JOB POST|GET /api/jobs/process-notification-deliveries
// Processa fila notification_deliveries (mock providers na Fase 2).
// Proteção: X-Job-Secret === JOB_SECRET quando JOB_SECRET definido.
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { runNotificationDeliveriesWorkerTick } from "../../services/notifications/notificationDeliveriesWorker.js";

export async function handleJobsProcessNotificationDeliveries(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    const traceId = getTraceId(req);
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  const traceId = getTraceId(req);
  const jobSecret = config.jobSecret != null ? String(config.jobSecret).trim() : "";
  const headerSecret =
    req.headers["x-job-secret"] != null ? String(req.headers["x-job-secret"]).trim() : "";

  if (jobSecret && headerSecret !== jobSecret) {
    return fail(res, { code: "UNAUTHORIZED", message: "Token de job inválido" }, 401, traceId);
  }

  try {
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      return ok(res, { ok: true, processed: 0, warning: "supabase_config_missing" }, 200);
    }

    let batchSize = 50;
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const qLimit = req.query?.limit ?? req.query?.batch_size;
      const raw = body.batch_size ?? body.limit ?? qLimit;
      if (raw != null) batchSize = Math.min(200, Math.max(1, Number.parseInt(String(raw), 10) || 50));
    } catch {
      /* ignore */
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const result = await runNotificationDeliveriesWorkerTick(supabase, { batchSize });
    if (!result.ok) {
      return fail(res, { code: "WORKER_ERROR", message: result.error ?? "worker_failed" }, 500, traceId);
    }

    return ok(res, { ok: true, processed: result.processed ?? 0, batch_size: batchSize, traceId }, 200);
  } catch (err) {
    console.error("[process-notification-deliveries]", err);
    return fail(res, { code: "INTERNAL", message: err instanceof Error ? err.message : "erro" }, 500, traceId);
  }
}
