// ======================================================================
// GET /api/sales/executive-summary — métricas executivas P_2.1.2
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { resolveExecutiveSummaryPeriod } from "../../domain/sales/saleExecutivePeriod.js";
import {
  buildEmptyExecutiveSummaryPayload,
  buildSaleExecutiveSummary,
} from "../../domain/sales/buildSaleExecutiveSummary.js";
import {
  executiveSummaryElapsedMs,
  logExecutiveSummaryError,
  logExecutiveSummaryResponseSent,
  logExecutiveSummaryStart,
} from "../../domain/sales/saleExecutiveSummaryTelemetry.js";
import {
  createExecutiveSummaryPerf,
  logExecutiveSummaryPerf,
} from "../../domain/sales/saleExecutiveSummaryPerf.js";

/**
 * @param {import("http").IncomingMessage} req
 */
function parseExecutiveSummaryFilters(req) {
  const marketplace =
    req.query?.marketplace != null && String(req.query.marketplace).trim() !== ""
      ? String(req.query.marketplace).trim()
      : null;
  const marketplaceAccountId =
    req.query?.marketplace_account_id != null && String(req.query.marketplace_account_id).trim() !== ""
      ? String(req.query.marketplace_account_id).trim()
      : null;
  const sellerCompanyId =
    req.query?.seller_company_id != null && String(req.query.seller_company_id).trim() !== ""
      ? String(req.query.seller_company_id).trim()
      : null;
  const q =
    req.query?.q != null && String(req.query.q).trim() !== "" ? String(req.query.q).trim() : null;
  const filter =
    req.query?.filter != null && String(req.query.filter).trim() !== ""
      ? String(req.query.filter).trim()
      : "all";
  const rankingLimitRaw = req.query?.ranking_limit;
  const ranking_limit =
    rankingLimitRaw != null ? Math.min(10, Math.max(1, parseInt(String(rankingLimitRaw), 10) || 10)) : 10;

  const periodResult = resolveExecutiveSummaryPeriod(req.query);
  if (!periodResult.ok) {
    return { ok: false, error: periodResult.error };
  }

  return {
    ok: true,
    filters: {
      marketplace,
      marketplace_account_id: marketplaceAccountId,
      seller_company_id: sellerCompanyId,
      q,
      filter,
      period: periodResult.period,
      ranking_limit,
      period_warnings: periodResult.warnings ?? [],
    },
  };
}

/**
 * @param {import("http").IncomingMessage} req
 */
function buildExecutiveSummaryQueryLog(req) {
  return {
    marketplace: req.query?.marketplace ?? null,
    marketplace_account_id: req.query?.marketplace_account_id ?? null,
    seller_company_id: req.query?.seller_company_id ?? null,
    q: req.query?.q ?? null,
    filter: req.query?.filter ?? "all",
    period_preset: req.query?.period_preset ?? null,
    start_date: req.query?.start_date ?? req.query?.period_start ?? null,
    end_date: req.query?.end_date ?? req.query?.period_end ?? null,
    ranking_limit: req.query?.ranking_limit ?? null,
  };
}

export default async function handleSalesExecutiveSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const startedAt = Date.now();
  const perf = createExecutiveSummaryPerf(startedAt);
  logExecutiveSummaryPerf("request_start", { seller_id: null });

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      perf.logResponseReady({ fallback: true, reason: "config_error" });
      return res.status(200).json(buildEmptyExecutiveSummaryPayload());
    }
    perf.logResponseReady({ status: auth.error.status, reason: "auth_error" });
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  perf.log("auth_resolved", { seller_id: user.id });

  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) {
    perf.logResponseReady({ gated: true });
    return;
  }

  const parsed = parseExecutiveSummaryFilters(req);
  if (!parsed.ok) {
    perf.logResponseReady({ status: 400, reason: "invalid_period" });
    return res.status(400).json({ ok: false, error: parsed.error });
  }

  perf.log("period_resolved", {
    preset: parsed.filters.period?.preset ?? null,
    start_date: parsed.filters.period?.start_date ?? null,
    end_date: parsed.filters.period?.end_date ?? null,
  });

  const queryLog = buildExecutiveSummaryQueryLog(req);
  logExecutiveSummaryStart({
    sellerId: user.id,
    query: queryLog,
    startedAt,
  });

  try {
    const payload = await buildSaleExecutiveSummary(supabase, user.id, parsed.filters, {
      startedAt,
      perf,
    });
    logExecutiveSummaryResponseSent({
      status: 200,
      ordersCount: payload?.summary?.orders_count ?? 0,
      listingsCount: Array.isArray(payload?.rankings?.listings) ? payload.rankings.listings.length : 0,
      truncatedScan: Boolean(payload?.truncated_scan),
      elapsedMs: executiveSummaryElapsedMs(startedAt),
    });
    perf.logResponseReady({
      status: 200,
      orders_count: payload?.summary?.orders_count ?? 0,
      listings_by_quantity: payload?.rankings?.listings_by_quantity?.length ?? 0,
    });
    return res.status(200).json(payload);
  } catch (error) {
    logExecutiveSummaryError({
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
      elapsedMs: executiveSummaryElapsedMs(startedAt),
    });
    console.error("[Suse7][API][sales-executive-summary] failed", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
    const fallback = buildEmptyExecutiveSummaryPayload(parsed.filters);
    fallback.data_quality = {
      status: "partial",
      warnings: [
        error?.message != null && String(error.message).trim() !== ""
          ? String(error.message)
          : "Falha ao calcular resumo executivo.",
      ],
    };
    logExecutiveSummaryResponseSent({
      status: 200,
      fallback: true,
      elapsedMs: executiveSummaryElapsedMs(startedAt),
    });
    perf.logResponseReady({ status: 200, fallback: true, error: error?.message ?? null });
    return res.status(200).json(fallback);
  }
}
