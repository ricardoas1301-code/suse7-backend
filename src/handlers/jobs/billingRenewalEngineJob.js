// ======================================================================
// POST|GET /api/jobs/billing-renewal-engine
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { evaluateBillingJobAuth } from "../../billing/middleware/evaluateBillingJobAuth.js";
import { getBillingProvider } from "../../billing/providers/index.js";
import { processBillingRenewalEngine } from "../../billing/services/billingRenewalEngine.js";
import { readRequestJson } from "../../billing/utils/readRequestJson.js";

export async function handleJobsBillingRenewalEngine(req, res) {
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
    const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
    const result = await processBillingRenewalEngine(supabase, {
      providerApi,
      requestId: traceId,
      jobName: "billing-renewal-engine",
      limit,
    });
    return ok(res, { ok: true, job: "billing-renewal-engine", ...result, traceId });
  } catch (error) {
    return fail(
      res,
      {
        code: "RENEWAL_ENGINE_JOB_FAILED",
        message: error instanceof Error ? error.message : "Falha no motor de renovação.",
      },
      500,
      traceId
    );
  }
}
