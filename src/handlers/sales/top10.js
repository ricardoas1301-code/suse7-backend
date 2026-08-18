// ======================================================================
// GET /api/sales/top10 — rankings leves (Top 10) sobre universo canônico.
// Reusa buildSaleExecutiveSummary; ranking fixo em 10; fail-soft 200.
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { resolveExecutiveSummaryPeriod } from "../../domain/sales/saleExecutivePeriod.js";
import {
  buildEmptyExecutiveSummaryPayload,
  buildSaleExecutiveSummary,
} from "../../domain/sales/buildSaleExecutiveSummary.js";
import {
  createExecutiveSummaryPerf,
  logExecutiveSummaryPerf,
} from "../../domain/sales/saleExecutiveSummaryPerf.js";

const LOG_PREFIX = "[S7_SALES_TOP10]";
const TOP10_TTL_MS = 45_000;

/** @type {Map<string, { expiresAt: number; payload: Record<string, unknown> }>} */
const top10Cache = new Map();

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function trimOrNull(v) {
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

/**
 * @param {import("http").IncomingMessage} req
 */
function parseTop10Filters(req) {
  const periodResult = resolveExecutiveSummaryPeriod(req.query);
  if (!periodResult.ok) {
    return { ok: false, error: periodResult.error };
  }

  const rankingLimitRaw = req.query?.ranking_limit;
  const ranking_limit =
    rankingLimitRaw != null
      ? Math.min(10, Math.max(1, parseInt(String(rankingLimitRaw), 10) || 10))
      : 10;

  return {
    ok: true,
    filters: {
      marketplace: trimOrNull(req.query?.marketplace),
      marketplace_account_id: trimOrNull(req.query?.marketplace_account_id),
      seller_company_id: trimOrNull(req.query?.seller_company_id),
      q: null,
      filter: "all",
      period: periodResult.period,
      ranking_limit,
      period_warnings: periodResult.warnings ?? [],
    },
  };
}

/**
 * @param {string} userId
 * @param {Record<string, unknown>} filters
 */
function top10CacheKey(userId, filters) {
  const period = /** @type {Record<string, unknown>} */ (filters.period ?? {});
  return [
    userId,
    filters.marketplace ?? "",
    filters.marketplace_account_id ?? "",
    filters.seller_company_id ?? "",
    period.preset ?? "",
    period.start_date ?? "",
    period.end_date ?? "",
    period.start_datetime ?? "",
    period.end_datetime ?? "",
    filters.ranking_limit ?? 10,
  ].join("|");
}

/**
 * Payload enxuto para o bloco Top 10 (mesmo contrato de rankings do executive-summary).
 * @param {Record<string, unknown>} full
 * @param {{ cacheHit?: boolean }} [opts]
 */
function toTop10Payload(full, opts = {}) {
  const rankings =
    full.rankings != null && typeof full.rankings === "object"
      ? /** @type {Record<string, unknown>} */ (full.rankings)
      : {};
  return {
    ok: true,
    period: full.period ?? null,
    summary: full.summary ?? null,
    rankings: {
      listings_by_quantity: Array.isArray(rankings.listings_by_quantity)
        ? rankings.listings_by_quantity
        : [],
      listings_by_gross_revenue: Array.isArray(rankings.listings_by_gross_revenue)
        ? rankings.listings_by_gross_revenue
        : [],
      listings_by_net_profit: Array.isArray(rankings.listings_by_net_profit)
        ? rankings.listings_by_net_profit
        : [],
    },
    cache_hit: Boolean(opts.cacheHit),
    data_quality: full.data_quality ?? { status: "complete", warnings: [] },
    truncated_scan: Boolean(full.truncated_scan),
  };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse & { status: Function; json: Function }} res
 */
export default async function handleSalesTop10(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const startedAt = Date.now();
  const perf = createExecutiveSummaryPerf(startedAt);
  logExecutiveSummaryPerf("top10_request_start", {});

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json(toTop10Payload(buildEmptyExecutiveSummaryPayload()));
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  perf.log("auth_resolved", { seller_id: user.id });

  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) {
    perf.logResponseReady({ gated: true });
    return;
  }

  const parsed = parseTop10Filters(req);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }

  perf.log("period_resolved", {
    preset: parsed.filters.period?.preset ?? null,
    start_date: parsed.filters.period?.start_date ?? null,
    end_date: parsed.filters.period?.end_date ?? null,
  });

  const key = top10CacheKey(user.id, parsed.filters);
  const cached = top10Cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    perf.logResponseReady({ cache_hit: true, status: 200 });
    console.info(`${LOG_PREFIX} cache_hit`, { seller_id: user.id, elapsed_ms: Date.now() - startedAt });
    return res.status(200).json({ ...cached.payload, cache_hit: true });
  }

  try {
    const full = await buildSaleExecutiveSummary(supabase, user.id, parsed.filters, {
      startedAt,
      perf,
      mode: "top10",
    });
    const payload = toTop10Payload(full, { cacheHit: false });
    top10Cache.set(key, { expiresAt: Date.now() + TOP10_TTL_MS, payload });
    perf.logResponseReady({
      status: 200,
      cache_hit: false,
      orders_count: payload.summary?.orders_count ?? 0,
      listings_by_quantity: payload.rankings.listings_by_quantity.length,
    });
    return res.status(200).json(payload);
  } catch (error) {
    const errorId = Date.now();
    console.error(`${LOG_PREFIX} failed`, {
      errorId,
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
      elapsed_ms: Date.now() - startedAt,
    });
    const fallback = toTop10Payload(buildEmptyExecutiveSummaryPayload(parsed.filters));
    fallback.data_quality = {
      status: "partial",
      warnings: [
        error?.message != null && String(error.message).trim() !== ""
          ? String(error.message)
          : "Falha ao calcular Top 10.",
      ],
    };
    perf.logResponseReady({ status: 200, fallback: true, errorId });
    return res.status(200).json(fallback);
  }
}
