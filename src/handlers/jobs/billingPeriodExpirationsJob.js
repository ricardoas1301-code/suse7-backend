// ======================================================================
// POST|GET /api/jobs/billing-process-period-expirations
// Proteção: X-Job-Secret quando JOB_SECRET (ou equivalentes) estiver configurado.
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { logBilling, logBillingError } from "../../billing/billingLog.js";
import { evaluateBillingJobAuth } from "../../billing/middleware/evaluateBillingJobAuth.js";
import { processBillingPeriodExpirations } from "../../billing/services/billingPeriodExpirationService.js";
import { readRequestJson } from "../../billing/utils/readRequestJson.js";

export async function handleJobsBillingProcessPeriodExpirations(req, res) {
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST ou GET" }, 405, traceId);
  }

  const auth = evaluateBillingJobAuth(req);
  if (!auth.allow) {
    logBilling("billing", "period_expirations_job_denied", { reason: auth.reason, mode: auth.mode });
    return fail(
      res,
      { code: "UNAUTHORIZED", message: "Token de job inválido ou ausente.", reason: auth.reason },
      401,
      traceId
    );
  }

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
  }

  let limit;
  try {
    const body = await readRequestJson(req);
    if (body && typeof body.limit === "number" && Number.isFinite(body.limit)) {
      limit = body.limit;
    }
  } catch {
    /* ignore */
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await processBillingPeriodExpirations(supabase, { limit });
    logBilling("billing", "period_expirations_job_ok", {
      scanned: result.scanned,
      processed_count: result.processed_count,
      failed_count: result.failed_count,
    });
    return ok(res, { ok: true, job: "billing-process-period-expirations", ...result, traceId });
  } catch (error) {
    logBillingError("billing", "period_expirations_job_failed", error, {});
    return fail(
      res,
      { code: "PERIOD_EXPIRATION_FAILED", message: error instanceof Error ? error.message : "Falha ao processar expirações." },
      500,
      traceId
    );
  }
}
