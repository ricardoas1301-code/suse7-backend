// ======================================================================
// POST|GET /api/jobs/marketplace-account-sync — processa marketplace_account_sync_jobs
// Proteção: X-Job-Secret === JOB_SECRET (ou S7_PROD_JOB_SECRET / S7_DEV_JOB_SECRET / ML_WEBHOOK_JOB_SECRET).
// Alternativa legada: Authorization: Bearer === CRON_SECRET ou query cron_secret.
//
// Concorrência / escala (serverless — cada POST é um “tick” do worker):
// - GLOBAL_SYNC_CONCURRENCY — máx. contas distintas em paralelo por onda (default 16)
// - MARKETPLACE_SYNC_CONCURRENCY_MERCADO_LIVRE — teto específico ML (default = global)
// - MARKETPLACE_SYNC_MAX_PARALLEL_ACCOUNTS — override explícito do min(global, ml)
// - MARKETPLACE_SYNC_CONCURRENCY_PER_ACCOUNT — reservado (hoje 1 job inicial por conta)
// - MARKETPLACE_SYNC_MAX_JOBS_PER_DRAIN — máx. dispatches por HTTP (default 24)
// - MARKETPLACE_SYNC_FETCH_POOL_LIMIT — linhas lidas do pool Supabase por tick (default 400)
// - MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS / ML_MARKETPLACE_SYNC_BUDGET_MS — budget por invocação
// - ML_INITIAL_SALES_BATCH_SIZE / ML_INITIAL_SALES_BATCH_DETAILS / MARKETPLACE_SYNC_SALES_PROGRESS_HEARTBEAT_EVERY
// - ML_REQUEST_TIMEOUT_MS, ML_REQUEST_MAX_RETRIES, ML_SYNC_MAX_CONCURRENT_REQUESTS_PER_ACCOUNT
// Body/query limit → MARKETPLACE_SYNC_MAX_JOBS_PER_DRAIN (compatível com maxChunks antigo)
//
// Infra: Vercel Hobby não mantém processo contínuo — use cron/agendador externo + este endpoint,
// ou migre para worker dedicado (Railway/Render/Fly/Cloud Run). Ver sql/marketplace_account_sync_jobs_queue_phase2.sql.
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { runMarketplaceAccountSyncWorker } from "../../services/marketplace/marketplaceAccountSyncWorker.js";

function resolveSupabaseHostForLog() {
  const raw =
    (typeof process.env.SUPABASE_URL === "string" && process.env.SUPABASE_URL.trim() !== ""
      ? process.env.SUPABASE_URL.trim()
      : null) ||
    (config.supabaseUrl && String(config.supabaseUrl).trim() !== "" ? String(config.supabaseUrl).trim() : "");
  if (!raw) return "(missing)";
  try {
    return new URL(raw).hostname;
  } catch {
    return "(invalid_url)";
  }
}

/**
 * @param {import("http").IncomingMessage} req
 */
function evaluateMarketplaceAccountSyncJobAuth(req) {
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
    return { allow: true, mode: "none", reason: null };
  }
  if (hasJobSecretAuth) {
    return { allow: true, mode: "x-job-secret", reason: null };
  }
  if (hasCronAuth) {
    return { allow: true, mode: "cron-secret", reason: null };
  }

  let reason = "invalid_job_secret";
  if (jobSecretConfigured && !headerSecret) {
    reason = "missing_job_secret_header";
  } else if (jobSecretConfigured && headerSecret) {
    reason = "invalid_job_secret";
  } else if (cronSecretConfigured && !bearerToken && !cronSecretQuery) {
    reason = "missing_cron_secret";
  } else if (cronSecretConfigured) {
    reason = "invalid_cron_secret";
  }

  return {
    allow: false,
    mode: null,
    reason,
    jobSecretConfigured,
    cronSecretConfigured,
    headerPresent: headerSecret !== "",
    bearerPresent: bearerToken !== "",
    cronQueryPresent: cronSecretQuery !== "",
  };
}

function authFailureMessage(reason) {
  if (reason === "missing_job_secret_header") return "Missing job secret header";
  if (reason === "invalid_job_secret") return "Invalid job secret";
  if (reason === "missing_cron_secret") return "Missing cron secret";
  if (reason === "invalid_cron_secret") return "Invalid cron secret";
  return "Job authentication failed";
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function logSyncCheckpoint(checkpoint, extra = {}) {
  console.info(`[marketplace-account-sync-job] CHECKPOINT_${checkpoint}`, {
    checkpoint,
    vercel_env: process.env.VERCEL_ENV ?? null,
    node_env: process.env.NODE_ENV ?? null,
    supabase_host: resolveSupabaseHostForLog(),
    job_secret_configured: Boolean(config.jobSecret && String(config.jobSecret).trim()),
    dev_job_secret_configured: Boolean(process.env.DEV_JOB_SECRET && String(process.env.DEV_JOB_SECRET).trim()),
    ...extra,
  });
}

export async function handleJobsMarketplaceAccountSync(req, res) {
  logSyncCheckpoint(1, { stage: "handler_entry", method: req.method });

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  console.info("[marketplace-account-sync-job] auth_check_start", {
    method: req.method,
    job_secret_configured: Boolean(config.jobSecret && String(config.jobSecret).trim()),
    cron_secret_configured: Boolean(config.cronSecret && String(config.cronSecret).trim()),
  });

  const auth = evaluateMarketplaceAccountSyncJobAuth(req);
  if (!auth.allow) {
    const reason = auth.reason ?? "invalid_job_secret";
    if (reason === "missing_job_secret_header" || reason === "missing_cron_secret") {
      console.warn("[marketplace-account-sync-job] auth_failed_missing_header", {
        reason,
        job_secret_configured: auth.jobSecretConfigured === true,
        cron_secret_configured: auth.cronSecretConfigured === true,
        x_job_secret_header: auth.headerPresent ? "present" : "missing",
        authorization_bearer: auth.bearerPresent ? "present" : "missing",
        cron_secret_query: auth.cronQueryPresent ? "present" : "missing",
      });
    } else {
      console.warn("[marketplace-account-sync-job] auth_failed_invalid_secret", {
        reason,
        job_secret_configured: auth.jobSecretConfigured === true,
        cron_secret_configured: auth.cronSecretConfigured === true,
        x_job_secret_header: auth.headerPresent ? "present" : "missing",
        authorization_bearer: auth.bearerPresent ? "present" : "missing",
        cron_secret_query: auth.cronQueryPresent ? "present" : "missing",
      });
    }
    return res.status(401).json({
      ok: false,
      error: authFailureMessage(reason),
      reason,
    });
  }

  logSyncCheckpoint(2, {
    stage: "auth_ok",
    auth_mode: auth.mode === "none" ? "none" : auth.mode,
  });

  if (auth.mode && auth.mode !== "none") {
    console.info("[marketplace-account-sync-job] auth_ok", { auth_mode: auth.mode });
  }

  console.log("[MARKETPLACE_SYNC_JOB_ENV]", {
    supabase_host: resolveSupabaseHostForLog(),
    vercel_env: process.env.VERCEL_ENV ?? null,
    node_env: process.env.NODE_ENV ?? null,
    supabase_url_present: Boolean(config.supabaseUrl && String(config.supabaseUrl).trim()),
    supabase_service_role_present: Boolean(
      config.supabaseServiceRoleKey && String(config.supabaseServiceRoleKey).trim(),
    ),
  });

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  logSyncCheckpoint(3, { stage: "supabase_client_ready" });

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

  const rawLimit = body.limit ?? req.query?.limit;
  /** @type {{ maxChunks?: number }} */
  const workerOpts = {};
  if (rawLimit != null && String(rawLimit).trim() !== "") {
    const n = parseInt(String(rawLimit), 10);
    if (Number.isFinite(n)) {
      workerOpts.maxChunks = Math.max(1, Math.min(50, n));
    }
  }

  try {
    logSyncCheckpoint(4, { stage: "worker_dispatch_start", worker_opts: workerOpts });
    const out = await runMarketplaceAccountSyncWorker(supabase, workerOpts);
    logSyncCheckpoint(5, {
      stage: "worker_dispatch_done",
      chunks_processed: out?.chunks_processed ?? 0,
    });
    logSyncCheckpoint(6, {
      stage: "incremental_sales_poll_done",
      incremental_sales_poll: out?.incremental_sales_poll ?? null,
    });
    console.log("[MARKETPLACE_SYNC_JOB_SUMMARY]", {
      chunks_processed: out?.chunks_processed ?? 0,
      requested_limit_chunks: workerOpts.maxChunks ?? null,
    });
    logSyncCheckpoint(7, {
      stage: "response_ok",
      chunks_processed: out?.chunks_processed ?? 0,
    });
    return res.status(200).json({
      ok: true,
      ...(Object.keys(workerOpts).length ? { requested_limit_chunks: workerOpts.maxChunks } : {}),
      ...out,
      auth_mode: auth.mode === "none" ? "none" : auth.mode,
      hint: "Agende este endpoint em cron (ex.: Vercel/GitHub Actions) com X-Job-Secret.",
    });
  } catch (e) {
    console.error("[jobs/marketplace-account-sync] fatal", {
      message: e?.message ? String(e.message) : String(e),
      name: e?.name ?? null,
      code: e?.code ?? null,
      stack: e?.stack ?? null,
    });
    return res.status(500).json({
      ok: false,
      error: e?.message ? String(e.message) : "Falha no worker de sync marketplace",
    });
  }
}
