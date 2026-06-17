// ======================================================================
// POST|GET /api/jobs/daily-sales-summary-automation
// Proteção: X-Job-Secret (padrão jobs S7)
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { processDailySalesSummaryAutomationMotor } from "../../domain/notifications/central/sales/processDailySalesSummaryAutomationMotor.js";
import { logCentralNotification } from "../../domain/notifications/central/observability/centralNotificationLog.js";

export async function handleJobsDailySalesSummaryAutomation(req, res) {
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST ou GET" }, 405, traceId);
  }

  const jobSecret = config.jobSecret != null ? String(config.jobSecret).trim() : "";
  const headerSecret =
    req.headers["x-job-secret"] != null ? String(req.headers["x-job-secret"]).trim() : "";

  logCentralNotification("DAILY_SALES_SUMMARY_JOB_START", {
    traceId,
    method,
    job_secret_configured: Boolean(jobSecret),
    job_secret_header_present: Boolean(headerSecret),
    auth_ok: !jobSecret || headerSecret === jobSecret,
  });

  if (jobSecret && headerSecret !== jobSecret) {
    return fail(res, { code: "UNAUTHORIZED", message: "Token de job inválido" }, 401, traceId);
  }

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
  }

  let limit;
  let overrideNow;
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
      limit = body.limit;
    }
    if (typeof body.override_now === "string" && body.override_now.trim()) {
      overrideNow = new Date(body.override_now.trim());
    }
  } catch {
    /* ignore */
  }

  const motorNow =
    overrideNow instanceof Date && Number.isFinite(overrideNow.getTime()) ? overrideNow : undefined;

  if (motorNow) {
    logCentralNotification("DAILY_SALES_SUMMARY_JOB_OVERRIDE_NOW", {
      traceId,
      override_now: motorNow.toISOString(),
    });
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await processDailySalesSummaryAutomationMotor(supabase, {
      limit,
      now: motorNow,
    });
    logCentralNotification("DAILY_SALES_SUMMARY_JOB_OK", { traceId, ...result });
    return ok(res, { ok: true, job: "daily-sales-summary-automation", ...result, traceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha no motor de resumo diário.";
    logCentralNotification("DAILY_SALES_SUMMARY_JOB_ERR", { traceId, message });
    return fail(res, { code: "DAILY_SALES_SUMMARY_JOB_FAILED", message }, 500, traceId);
  }
}
