// ======================================================================
// POST|GET /api/jobs/billing-consistency-check
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { evaluateBillingJobAuth } from "../../billing/middleware/evaluateBillingJobAuth.js";
import { runBillingConsistencyChecks } from "../../billing/services/billingConsistencyCheckService.js";
import { readRequestJson } from "../../billing/utils/readRequestJson.js";

export async function handleJobsBillingConsistencyCheck(req, res) {
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST ou GET" }, 405, traceId);
  }

  const auth = evaluateBillingJobAuth(req);
  if (!auth.allow) {
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

  let autoReconcile = false;
  try {
    const body = await readRequestJson(req);
    if (body?.auto_reconcile_open_cycles === true) autoReconcile = true;
  } catch {
    /* ignore */
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await runBillingConsistencyChecks(supabase, {
      autoReconcileOpenCycles: autoReconcile,
      requestId: traceId,
    });
    return ok(res, { ok: true, job: "billing-consistency-check", ...result, traceId });
  } catch (error) {
    return fail(
      res,
      {
        code: "BILLING_CONSISTENCY_CHECK_FAILED",
        message: error instanceof Error ? error.message : "Falha na verificação de consistência.",
      },
      500,
      traceId
    );
  }
}
