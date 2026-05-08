// ======================================================================
// POST|GET /api/jobs/marketplace-account-sync — processa marketplace_account_sync_jobs
// Proteção: X-Job-Secret === JOB_SECRET (quando JOB_SECRET está definido).
//
// Env opcional:
// - ML_MARKETPLACE_SYNC_BUDGET_MS (default 55000)
// - ML_INITIAL_SALES_BATCH_DETAILS (default 14)
// - ML_MARKETPLACE_SYNC_JOB_MAX_CHUNKS (default 8)
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { runMarketplaceAccountSyncWorker } from "../../services/marketplace/marketplaceAccountSyncWorker.js";

/**
 * Host do projeto Supabase efetivo (sem keys/tokens).
 * Usa SUPABASE_URL do ambiente; fallback para config carregada pelo servidor.
 */
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
 * @param {import("http").ServerResponse} res
 */
export async function handleJobsMarketplaceAccountSync(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

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
  const hasJobSecretAuth = jobSecret !== "" && headerSecret === jobSecret;
  const hasCronAuth =
    cronSecret !== "" &&
    (bearerToken === cronSecret || cronSecretQuery === cronSecret);

  if (jobSecret || cronSecret) {
    if (!hasJobSecretAuth && !hasCronAuth) {
      return res.status(401).json({ ok: false, error: "Token de job inválido" });
    }
  }

  console.log("[MARKETPLACE_SYNC_JOB_ENV]", {
    supabase_host: resolveSupabaseHostForLog(),
    vercel_env: process.env.VERCEL_ENV ?? null,
    node_env: process.env.NODE_ENV ?? null,
  });

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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
    const out = await runMarketplaceAccountSyncWorker(supabase, workerOpts);
    console.log("[MARKETPLACE_SYNC_JOB_SUMMARY]", {
      chunks_processed: out?.chunks_processed ?? 0,
      requested_limit_chunks: workerOpts.maxChunks ?? null,
    });
    return res.status(200).json({
      ok: true,
      ...(Object.keys(workerOpts).length ? { requested_limit_chunks: workerOpts.maxChunks } : {}),
      ...out,
      auth_mode: hasJobSecretAuth ? "x-job-secret" : hasCronAuth ? "cron-secret" : "none",
      hint: "Agende este endpoint em cron (ex.: Vercel/GitHub Actions) com X-Job-Secret.",
    });
  } catch (e) {
    console.error("[jobs/marketplace-account-sync] fatal", e);
    return res.status(500).json({
      ok: false,
      error: e?.message ? String(e.message) : "Falha no worker de sync marketplace",
    });
  }
}
