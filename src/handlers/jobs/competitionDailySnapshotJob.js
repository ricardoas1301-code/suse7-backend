// ======================================================================
// POST|GET /api/jobs/competition-daily-snapshot
// Proteção: X-Job-Secret (manual/GitHub) | Authorization Bearer CRON_SECRET
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { runCompetitionDailySnapshotBatch } from "../../domain/competition/competitionDailySnapshotService.js";

/**
 * @param {import("http").IncomingMessage} req
 */
function evaluateCompetitionDailySnapshotJobAuth(req) {
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
    return { allow: true, mode: "none", reason: "no_secret_configured" };
  }
  if (hasJobSecretAuth) return { allow: true, mode: "x-job-secret", reason: null };
  if (hasCronAuth) return { allow: true, mode: "cron-secret", reason: null };
  return { allow: false, mode: null, reason: "token_invalid_or_missing" };
}

/**
 * @param {import("http").IncomingMessage} req
 */
function parseCompetitionDailySnapshotInput(req) {
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
  const readNumber = (raw) => {
    if (raw == null || String(raw).trim() === "") return undefined;
    const parsed = Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    limit: readNumber(body.limit ?? req.query?.limit),
    maxPerRun: readNumber(body.max_per_run ?? body.maxPerRun ?? req.query?.max_per_run ?? req.query?.maxPerRun),
  };
}

export async function handleJobsCompetitionDailySnapshot(req, res) {
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST ou GET" }, 405, traceId);
  }

  const auth = evaluateCompetitionDailySnapshotJobAuth(req);
  if (!auth.allow) {
    console.warn("[S7_COMPETITION_DAILY_SNAPSHOT_AUTH_FAILED]", {
      traceId,
      reason: auth.reason,
      auth_mode: auth.mode,
      method,
      cron_invocation: req.headers["x-vercel-cron"] != null ? String(req.headers["x-vercel-cron"]) : null,
      vercel_env: process.env.VERCEL_ENV ?? null,
    });
    return fail(
      res,
      { code: "UNAUTHORIZED", message: "Token de job inválido ou ausente.", details: { reason: auth.reason } },
      401,
      traceId
    );
  }

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
  }

  const input = parseCompetitionDailySnapshotInput(req);
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await runCompetitionDailySnapshotBatch(supabase, {
      limit: input.limit,
      maxPerRun: input.maxPerRun,
    });
    return ok(res, {
      ok: true,
      job: "competition-daily-snapshot",
      processed: result.processed,
      updated: result.updated,
      unchanged_touched: result.unchanged_touched ?? result.unchanged ?? 0,
      unchanged: result.unchanged ?? result.unchanged_touched ?? 0,
      failed: result.failed,
      skipped_today: result.skipped_today,
      remaining_estimate: result.remaining_estimate,
      sample_results: Array.isArray(result.sample_results) ? result.sample_results : [],
      day_start_brt: result.day_start_brt,
      timezone: result.timezone ?? "America/Sao_Paulo",
      batch_size: result.batch_size,
      duration_ms: result.duration_ms,
      item_duration_avg_ms: result.item_duration_avg_ms ?? 0,
      item_duration_max_ms: result.item_duration_max_ms ?? 0,
      timed_out: result.timed_out,
      traceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha na rotina diária de concorrência.";
    return fail(res, { code: "COMPETITION_DAILY_SNAPSHOT_FAILED", message }, 500, traceId);
  }
}
