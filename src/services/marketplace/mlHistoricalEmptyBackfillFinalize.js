// ======================================================================
// Finalização terminal do backfill histórico ML quando a API prova zero pedidos.
// Distinção: janela vazia ≠ histórico global vazio — probe do período completo decide.
// ======================================================================

import { searchSellerOrdersPage, resolveMlOrdersSearchSort } from "../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { ML_SALES_HOT_TYPES } from "./createMlInitialSyncJobs.js";
import { pickLatestAmong } from "./mlAccountSyncChecklist.js";
import { readJobMetadata } from "./mlHistoricalSalesUx.js";
import { completeMarketplaceSyncJob } from "./marketplaceSyncJobHelpers.js";

const HISTORICAL_JOB_TYPE = "ml_historical_sales_backfill";

/**
 * @param {Record<string, unknown> | null | undefined} job
 */
export function readHistoricalJobImportStats(job) {
  const m = readJobMetadata(job);
  return {
    saved: Number(m.ml_sales_import_saved) || 0,
    api: m.ml_sales_import_api_total != null ? Number(m.ml_sales_import_api_total) : null,
  };
}

/**
 * @param {Record<string, unknown>[]} historicalJobs
 */
export function resolveHistoricalPeriodBounds(historicalJobs) {
  for (const job of historicalJobs) {
    const meta = readJobMetadata(job);
    const dateFrom =
      meta.historical_period_start != null ? String(meta.historical_period_start).trim() : "";
    const dateTo =
      meta.historical_period_end != null ? String(meta.historical_period_end).trim() : "";
    if (dateFrom && dateTo) return { dateFrom, dateTo };
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} hotJob
 */
export function hotRecentProvesEmpty(hotJob) {
  if (!hotJob || String(hotJob.status || "").toLowerCase() !== "done") return false;
  const stats = readHistoricalJobImportStats(hotJob);
  if (stats.saved > 0) return false;
  if (stats.api != null && stats.api > 0) return false;
  return true;
}

/**
 * @param {Record<string, unknown>[]} doneHistoricalJobs
 */
export function doneHistoricalWindowsProveEmpty(doneHistoricalJobs) {
  if (!Array.isArray(doneHistoricalJobs) || doneHistoricalJobs.length === 0) return false;
  for (const job of doneHistoricalJobs) {
    const stats = readHistoricalJobImportStats(job);
    if (stats.saved > 0) return false;
    if (stats.api != null && stats.api > 0) return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>[]} allJobRows
 */
export function historicalBackfillNeedsTerminalization(allJobRows) {
  const historical = allJobRows.filter((r) => String(r.job_type || "") === HISTORICAL_JOB_TYPE);
  if (historical.length === 0) return false;
  const incomplete = historical.some((r) => {
    const st = String(r.status || "").toLowerCase();
    return st === "pending" || st === "running";
  });
  if (!incomplete) return false;

  const hot = pickLatestAmong(allJobRows, ML_SALES_HOT_TYPES);
  if (!hotRecentProvesEmpty(hot)) return false;

  const done = historical.filter((r) => String(r.status || "").toLowerCase() === "done");
  if (done.length > 0 && !doneHistoricalWindowsProveEmpty(done)) return false;
  return true;
}

/**
 * @param {{
 *   accessToken: string;
 *   sellerId: string;
 *   dateFrom: string;
 *   dateTo: string;
 *   marketplaceAccountId: string;
 * }} ctx
 */
export async function probeMlHistoricalRangeOrdersTotal(ctx) {
  const page = await searchSellerOrdersPage(ctx.accessToken, ctx.sellerId, 0, 1, {
    dateFrom: ctx.dateFrom,
    dateTo: ctx.dateTo,
    marketplaceAccountId: ctx.marketplaceAccountId,
    sort: resolveMlOrdersSearchSort(),
  });
  const raw = Number(page?.paging?.total);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   accountId: string;
 *   allJobRows: Record<string, unknown>[];
 *   reason: string;
 * }} ctx
 */
export async function finalizeRemainingEmptyHistoricalBackfillJobs(supabase, ctx) {
  const historical = ctx.allJobRows.filter((r) => String(r.job_type || "") === HISTORICAL_JOB_TYPE);
  const incomplete = historical.filter((r) => {
    const st = String(r.status || "").toLowerCase();
    return st === "pending" || st === "running";
  });
  if (incomplete.length === 0) return { finalized: 0, skipped: "already_complete" };

  const nowIso = new Date().toISOString();
  let finalized = 0;
  for (const job of incomplete) {
    const meta = {
      ...readJobMetadata(job),
      phase: "historical_sales_window",
      sync_job_kind: HISTORICAL_JOB_TYPE,
      ml_sales_import_api_total: 0,
      ml_sales_import_saved: 0,
      empty_history: true,
      empty_history_short_circuit: true,
      empty_history_reason: ctx.reason,
      finalized_at: nowIso,
    };
    await completeMarketplaceSyncJob(supabase, String(job.id), {
      progress_total: 0,
      progress_current: 0,
      last_cursor: null,
      last_synced_at: nowIso,
      error_message: null,
      metadata: meta,
    });
    finalized += 1;
  }

  console.info("[ML_HISTORICAL_EMPTY_BACKFILL_FINALIZED]", {
    marketplace_account_id: ctx.accountId,
    finalized,
    reason: ctx.reason,
  });

  return { finalized, skipped: finalized > 0 ? null : "none_updated" };
}

/**
 * Prova terminal via probe do período histórico completo e conclui janelas restantes.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   accountId: string;
 *   sellerId: string;
 *   accessToken: string;
 *   allJobRows: Record<string, unknown>[];
 *   reason?: string;
 * }} ctx
 */
export async function tryFinalizeEmptyHistoricalBackfillIfProven(supabase, ctx) {
  if (!historicalBackfillNeedsTerminalization(ctx.allJobRows)) {
    return { finalized: 0, skipped: "preconditions_not_met" };
  }

  const historical = ctx.allJobRows.filter((r) => String(r.job_type || "") === HISTORICAL_JOB_TYPE);
  const bounds = resolveHistoricalPeriodBounds(historical);
  if (!bounds) {
    return { finalized: 0, skipped: "missing_period_bounds" };
  }

  let apiTotal = 0;
  try {
    apiTotal = await probeMlHistoricalRangeOrdersTotal({
      accessToken: ctx.accessToken,
      sellerId: ctx.sellerId,
      dateFrom: bounds.dateFrom,
      dateTo: bounds.dateTo,
      marketplaceAccountId: ctx.accountId,
    });
  } catch (err) {
    const message = err?.message ? String(err.message) : String(err);
    console.warn("[ML_HISTORICAL_EMPTY_BACKFILL_PROBE_WARN]", {
      marketplace_account_id: ctx.accountId,
      message: message.slice(0, 500),
    });
    return { finalized: 0, skipped: "probe_failed", error: message };
  }

  if (apiTotal > 0) {
    return { finalized: 0, skipped: "full_range_has_orders", api_total: apiTotal };
  }

  return finalizeRemainingEmptyHistoricalBackfillJobs(supabase, {
    accountId: ctx.accountId,
    allJobRows: ctx.allJobRows,
    reason: ctx.reason ?? "full_range_api_total_zero",
  });
}
