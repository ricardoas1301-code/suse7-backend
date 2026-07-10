// ======================================================================
// POST|GET /api/jobs/pricing-current-state-backfill
// Proteção: X-Job-Secret | Authorization Bearer CRON_SECRET
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import {
  normalizePricingCurrentStateBackfillInput,
  runPricingCurrentStateBackfillBatch,
} from "../../domain/pricing/pricingCurrentStateBackfillService.js";

/**
 * @param {import("http").IncomingMessage} req
 */
function evaluatePricingCurrentStateBackfillJobAuth(req) {
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
function parsePricingCurrentStateBackfillBody(req) {
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
  return {
    ...body,
    seller_id: body.seller_id ?? body.sellerId ?? req.query?.seller_id ?? req.query?.seller,
    account_id: body.account_id ?? body.accountId ?? req.query?.account_id,
    listing_ids: body.listing_ids ?? body.listingIds ?? req.query?.listing_ids ?? req.query?.listing_ids,
    only_missing: body.only_missing ?? body.onlyMissing ?? req.query?.only_missing,
    force_recalculate: body.force_recalculate ?? body.forceRecalculate ?? req.query?.force_recalculate,
    concurrency: body.concurrency ?? req.query?.concurrency,
    limit: body.limit ?? req.query?.limit,
  };
}

export async function handleJobsPricingCurrentStateBackfill(req, res) {
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST ou GET" }, 405, traceId);
  }

  const auth = evaluatePricingCurrentStateBackfillJobAuth(req);
  if (!auth.allow) {
    console.warn("[S7_PRICING_CURRENT_STATE_BACKFILL_AUTH_FAILED]", {
      traceId,
      reason: auth.reason,
      auth_mode: auth.mode,
      method,
    });
    return fail(
      res,
      { code: "UNAUTHORIZED", message: "Token de job inválido ou ausente.", details: { reason: auth.reason } },
      401,
      traceId,
    );
  }

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
  }

  const input = normalizePricingCurrentStateBackfillInput(parsePricingCurrentStateBackfillBody(req));
  if (!input.sellerId) {
    return fail(
      res,
      { code: "VALIDATION_ERROR", message: "seller_id é obrigatório." },
      400,
      traceId,
    );
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await runPricingCurrentStateBackfillBatch(supabase, input);
    return ok(
      res,
      {
        ok: true,
        job: "pricing-current-state-backfill",
        ...result,
      },
      200,
      traceId,
    );
  } catch (err) {
    console.error("[S7_PRICING_CURRENT_STATE_BACKFILL_JOB_FAILED]", {
      traceId,
      message: err instanceof Error ? err.message : String(err),
    });
    return fail(
      res,
      {
        code: "BACKFILL_FAILED",
        message: err instanceof Error ? err.message : "Falha no backfill de pricing_current_state.",
      },
      500,
      traceId,
    );
  }
}
