// ======================================================================
// POST|GET /api/jobs/billing-billable-sale-admission-reconciler
// S1.HF.6.9A.10 — reconciliador recorrente (alvo: a cada 60s)
// Proteção: X-Job-Secret | Authorization Bearer CRON_SECRET
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { runBillableSaleAdmissionReconcilerJob } from "../../billing/jobs/billingBillableSaleAdmissionReconcilerJob.js";

/**
 * @param {import("http").IncomingMessage} req
 */
function evaluateJobAuth(req) {
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
 * @param {import("http").ServerResponse} res
 */
export default async function billingBillableSaleAdmissionReconcilerJobHandler(req, res) {
  const traceId = getTraceId(req);
  const auth = evaluateJobAuth(req);
  if (!auth.allow) {
    return fail(res, 401, "unauthorized", { traceId });
  }

  const supabaseUrl = config.supabaseUrl;
  const serviceKey = config.supabaseServiceRoleKey;
  if (!supabaseUrl || !serviceKey) {
    return fail(res, 500, "supabase_env_missing", { traceId });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const result = await runBillableSaleAdmissionReconcilerJob(supabase, {
      source: `http_job:${auth.mode}`,
      batchLimit: 100,
    });
    return ok(res, { ...result, auth_mode: auth.mode }, { traceId });
  } catch (err) {
    return fail(res, 500, "reconciler_failed", {
      traceId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
