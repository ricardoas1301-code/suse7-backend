// ======================================================================
// POST|GET /api/jobs/daily-sales-summary-automation
// Proteção: X-Job-Secret (GitHub/manual) | Authorization Bearer CRON_SECRET (Vercel Cron)
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { processDailySalesSummaryAutomationMotor } from "../../domain/notifications/central/sales/processDailySalesSummaryAutomationMotor.js";
import {
  evaluateDailySalesWakeExecution,
  resolveDailySalesWakeSource,
} from "../../domain/notifications/central/sales/dailySalesSummaryWakePolicy.js";
import { logCentralNotification } from "../../domain/notifications/central/observability/centralNotificationLog.js";

/**
 * @param {import("http").IncomingMessage} req
 */
export function evaluateDailySalesSummaryJobAuth(req) {
  const jobSecret = config.jobSecret != null ? String(config.jobSecret).trim() : "";
  const cronSecret = config.cronSecret != null ? String(config.cronSecret).trim() : "";
  const headerSecret =
    req.headers["x-job-secret"] != null ? String(req.headers["x-job-secret"]).trim() : "";
  const authHeader = req.headers["authorization"] != null ? String(req.headers["authorization"]) : "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const cronSecretQuery =
    req.query?.cron_secret != null ? String(req.query.cron_secret).trim() : "";

  const jobSecretConfigured = jobSecret !== "";
  const cronSecretConfigured = cronSecret !== "";
  const hasJobSecretAuth = jobSecretConfigured && headerSecret === jobSecret;
  const hasCronAuth =
    cronSecretConfigured && (bearerToken === cronSecret || cronSecretQuery === cronSecret);

  if (!jobSecretConfigured && !cronSecretConfigured) {
    return { allow: true, mode: "none" };
  }
  if (hasJobSecretAuth) return { allow: true, mode: "x-job-secret" };
  if (hasCronAuth) return { allow: true, mode: "cron-secret" };

  return { allow: false, mode: null };
}

/**
 * @param {import("http").IncomingMessage} req
 */
function parseDailySalesSummaryJobInput(req) {
  /** @type {Record<string, unknown>} */
  let body = {};
  try {
    if (typeof req.body === "string") {
      body = req.body.trim() ? JSON.parse(req.body) : {};
    } else if (req.body && typeof req.body === "object") {
      body = req.body;
    }
  } catch {
    body = {};
  }

  let limit;
  const rawLimit = body.limit ?? req.query?.limit;
  if (rawLimit != null) {
    const parsed = Number.parseInt(String(rawLimit), 10);
    if (Number.isFinite(parsed)) limit = parsed;
  }

  let overrideNow;
  const rawOverride = body.override_now ?? req.query?.override_now;
  if (typeof rawOverride === "string" && rawOverride.trim()) {
    overrideNow = new Date(rawOverride.trim());
  }

  let concurrency;
  const rawConcurrency = body.concurrency ?? req.query?.concurrency;
  if (rawConcurrency != null) {
    const parsed = Number.parseInt(String(rawConcurrency), 10);
    if (Number.isFinite(parsed) && parsed > 0) concurrency = parsed;
  }

  return { limit, overrideNow, concurrency };
}

export async function handleJobsDailySalesSummaryAutomation(req, res) {
  const jobStartedAtIso = new Date().toISOString();
  const jobStartedAtMs = Date.now();
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST ou GET" }, 405, traceId);
  }

  const auth = evaluateDailySalesSummaryJobAuth(req);
  const wakeAt = new Date().toISOString();
  const wakeSource = resolveDailySalesWakeSource(req, { authMode: auth.mode });

  logCentralNotification("DAILY_SALES_SUMMARY_JOB_START", {
    traceId,
    method,
    wake_source: wakeSource,
    wake_at: wakeAt,
    trigger:
      wakeSource === "vercel_cron"
        ? "vercel_cron"
        : auth.mode === "x-job-secret"
          ? "job_secret"
          : auth.mode === "cron-secret"
            ? "cron_secret"
            : "open",
    auth_mode: auth.mode ?? "denied",
    vercel_env: process.env.VERCEL_ENV ?? null,
    cron_invocation: req.headers["x-vercel-cron"] != null ? String(req.headers["x-vercel-cron"]) : null,
  });

  // Auth primeiro: secret invalido nunca vira skip (nao mascara 401).
  if (!auth.allow) {
    return fail(res, { code: "UNAUTHORIZED", message: "Token de job inválido" }, 401, traceId);
  }

  const wakeDecision = evaluateDailySalesWakeExecution({ wakeSource });
  logCentralNotification("DAILY_SALES_SUMMARY_WAKE_POLICY", {
    traceId,
    wake_source: wakeSource,
    wake_at: wakeAt,
    vercel_wake_enabled: wakeDecision.vercel_wake_enabled,
    execute: wakeDecision.execute,
    skip_reason: wakeDecision.skip_reason,
  });

  if (!wakeDecision.execute) {
    return ok(res, {
      ok: true,
      skipped: true,
      reason: wakeDecision.skip_reason,
      wake_source: wakeSource,
      wake_at: wakeAt,
      wake_enabled: wakeDecision.vercel_wake_enabled,
      job: "daily-sales-summary-automation",
      processed_count: 0,
      scanned: 0,
      completed: 0,
      failed: 0,
      skipped_rules: 0,
      hint: "Vercel Cron Daily Sales wake desabilitado (DAILY_SALES_VERCEL_WAKE_ENABLED). Anti-dual ate cutover.",
      traceId,
    });
  }

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
  }

  const { limit, overrideNow, concurrency } = parseDailySalesSummaryJobInput(req);

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
      concurrency,
    });
    const jobFinishedAtIso = new Date().toISOString();
    logCentralNotification("DAILY_SALES_SUMMARY_JOB_PERF", {
      traceId,
      scheduled_time: motorNow?.toISOString?.() ?? null,
      started_at: jobStartedAtIso,
      finished_at: jobFinishedAtIso,
      processed_count: Number(result.processed_count ?? result.scanned ?? 0),
      success_count: Number(result.success_count ?? result.completed ?? 0),
      failed_count: Number(result.failed_count ?? result.failed ?? 0),
      duration_ms: Date.now() - jobStartedAtMs,
      sellers: Array.isArray(result.seller_executions)
        ? result.seller_executions.map((row) => ({
            seller_id: row?.seller_id ?? null,
            started_at: row?.started_at ?? null,
            finished_at: row?.finished_at ?? null,
            duration_ms: row?.duration_ms ?? null,
            processed_count: row?.processed_count ?? null,
            success_count: row?.success_count ?? null,
            failed_count: row?.failed_count ?? null,
            scheduled_time: row?.scheduled_time ?? null,
          }))
        : [],
    });
    logCentralNotification("DAILY_SALES_SUMMARY_JOB_OK", {
      traceId,
      wake_source: wakeSource,
      wake_at: wakeAt,
      ...result,
    });
    return ok(res, {
      ok: true,
      job: "daily-sales-summary-automation",
      wake_source: wakeSource,
      wake_at: wakeAt,
      wake_enabled: wakeDecision.vercel_wake_enabled,
      ...result,
      traceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha no motor de resumo diário.";
    logCentralNotification("DAILY_SALES_SUMMARY_JOB_ERR", { traceId, message });
    return fail(res, { code: "DAILY_SALES_SUMMARY_JOB_FAILED", message }, 500, traceId);
  }
}
