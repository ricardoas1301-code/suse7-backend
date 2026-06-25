// ======================================================================
// Worker assíncrono: marketplace_account_sync_jobs (Mercado Livre inicial).
// Invocado pelo cron POST /api/jobs/marketplace-account-sync (X-Job-Secret).
// ======================================================================

import {
  fetchMercadoLibreUserMe,
  fetchOrderById,
  nextOrdersSearchOffset,
  resetMlDrainRequestMetrics,
  resolveMlOrdersSearchSort,
  searchSellerOrdersPage,
  snapshotMlDrainRequestMetrics,
} from "../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { applyMlOrderDetailToMarketplaceSales } from "../../modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { ingestCustomersFromSales } from "../customers/customerIngestionService.js";
import {
  ML_ALL_ACCOUNT_SYNC_JOB_TYPES,
  enqueueHistoricalSalesBackfillJobs,
  resolveMlInitialRecentDays,
  ML_SALES_HOT_TYPES,
  ML_LISTINGS_TYPES,
  ML_CUSTOMERS_TYPES,
} from "./createMlInitialSyncJobs.js";
import {
  ensureMarketplaceSyncJobRunning,
  patchMarketplaceSyncJob,
  completeMarketplaceSyncJob,
  failMarketplaceSyncJob,
} from "./marketplaceSyncJobHelpers.js";
import { runMlInitialListingsSyncJobTurn } from "../../handlers/ml/_helpers/mlInitialOnboardingListingsSync.js";
import { runMlInitialProductsSyncJobTurn } from "../../handlers/ml/_helpers/mlInitialOnboardingProductsSync.js";
import { runMlInitialFeesSyncTurn } from "./mlFeesSyncService.js";
import { upsertMarketplaceSalesImportCoverage } from "./marketplaceSalesImportCoverageService.js";
import { advanceMlSalesWatermark } from "./mlSalesAccountWatermark.js";
import { runIncrementalMlSalesPollWave } from "./mlIncrementalSalesPoll.js";

function resolveSalesSearchPageLimit() {
  return Math.min(
    50,
    Math.max(1, parseInt(process.env.ML_INITIAL_SALES_BATCH_SIZE || "50", 10) || 50)
  );
}

function resolveDrainTimeboxMs(opts = {}) {
  const raw =
    opts.budgetMs ??
    process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS ??
    process.env.ML_MARKETPLACE_SYNC_BUDGET_MS ??
    "10000";
  return Math.min(
    120000,
    Math.max(3000, parseInt(String(raw), 10) || 10000)
  );
}

function resolveMaxJobsPerDrain(opts = {}) {
  if (opts.maxChunks != null && String(opts.maxChunks).trim() !== "") {
    const n = parseInt(String(opts.maxChunks), 10);
    if (Number.isFinite(n)) return Math.min(500, Math.max(1, n));
  }
  return Math.min(
    500,
    Math.max(1, parseInt(process.env.MARKETPLACE_SYNC_MAX_JOBS_PER_DRAIN || "24", 10) || 24)
  );
}

/**
 * Limite global de jobs Mercado Livre processados em paralelo neste drain (contas distintas).
 * SaaS: default alto; reduza se ML 429 aumentar.
 */
function resolveGlobalSyncConcurrency() {
  return Math.min(
    500,
    Math.max(1, parseInt(process.env.GLOBAL_SYNC_CONCURRENCY || "16", 10) || 16)
  );
}

/** Teto por marketplace (hoje só ML neste worker). */
function resolveMarketplaceMlConcurrency() {
  const raw = process.env.MARKETPLACE_SYNC_CONCURRENCY_MERCADO_LIVRE;
  if (raw == null || String(raw).trim() === "") {
    return resolveGlobalSyncConcurrency();
  }
  return Math.min(
    500,
    Math.max(1, parseInt(String(raw), 10) || resolveGlobalSyncConcurrency())
  );
}

/**
 * Máximo de contas distintas nesta onda: min(global, marketplace, override opcional, vagas restantes).
 * MARKETPLACE_SYNC_CONCURRENCY_PER_ACCOUNT reserva futura — hoje o pipeline exige 1 job sync por conta.
 */
function resolveFetchJobsPoolLimit() {
  return Math.min(
    2000,
    Math.max(50, parseInt(process.env.MARKETPLACE_SYNC_FETCH_POOL_LIMIT || "400", 10) || 400)
  );
}

function resolveEffectiveWaveParallelism(slotsLeft) {
  let cap = Math.min(resolveGlobalSyncConcurrency(), resolveMarketplaceMlConcurrency());
  const explicit = process.env.MARKETPLACE_SYNC_MAX_PARALLEL_ACCOUNTS;
  if (explicit != null && String(explicit).trim() !== "") {
    const n = parseInt(String(explicit), 10);
    if (Number.isFinite(n)) cap = Math.min(cap, Math.min(500, Math.max(1, n)));
  }
  return Math.min(Math.max(1, cap), Math.max(0, slotsLeft));
}

function resolveSalesProgressHeartbeatEvery() {
  return Math.min(
    50,
    Math.max(1, parseInt(process.env.MARKETPLACE_SYNC_SALES_PROGRESS_HEARTBEAT_EVERY || "8", 10) || 8)
  );
}

function resolveBatchDetails(opts, salesPageLimit) {
  if (opts.batchDetails != null && String(opts.batchDetails).trim() !== "") {
    const n = parseInt(String(opts.batchDetails), 10);
    if (Number.isFinite(n)) return Math.min(80, Math.max(1, n));
  }
  const fromEnv = process.env.ML_INITIAL_SALES_BATCH_DETAILS;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    const n = parseInt(String(fromEnv), 10);
    if (Number.isFinite(n)) return Math.min(80, Math.max(1, n));
  }
  return Math.min(80, Math.max(4, salesPageLimit));
}

/** Janela máx. pedida ao ML no job “histórico” (API não garante além de ~12 meses). */
const ML_INITIAL_ORDERS_LOOKBACK_DAYS = Math.min(
  400,
  Math.max(1, parseInt(process.env.ML_INITIAL_ORDERS_LOOKBACK_DAYS || "365", 10) || 365)
);

/** Desempate entre jobs mesma prioridade UX — menor = mais “à frente” no pipeline. */
const PIPELINE_STEP_RANK = {
  ml_initial_sales_recent: 1,
  ml_initial_sales_history: 1,
  ml_historical_sales_backfill: 2,
  ml_initial_listings_current: 3,
  ml_initial_listings: 3,
  ml_initial_fees: 4,
  ml_initial_products: 5,
  ml_initial_customers_recent: 6,
  ml_initial_customers: 6,
  ml_historical_customers_backfill: 7,
  ml_sales_enrichment_backfill: 8,
  ml_enable_webhook_monitoring: 9,
};
const ORDER_PROCESS_TIMEOUT_MS = Math.min(
  180000,
  Math.max(5000, parseInt(process.env.ML_INITIAL_SALES_ORDER_PROCESS_TIMEOUT_MS || "45000", 10) || 45000)
);
const RUNNING_STALE_TIMEOUT_MS = Math.min(
  24 * 60 * 60 * 1000,
  Math.max(60 * 1000, parseInt(process.env.ML_INITIAL_SYNC_RUNNING_STALE_TIMEOUT_MS || "900000", 10) || 900000)
);
/**
 * @param {string} event
 * @param {Record<string, unknown>} payload
 */
function logS7Drain(event, payload) {
  console.info(`[S7][${event}]`, payload);
}

/**
 * @param {string} tag
 * @param {Record<string, unknown>} payload
 */
function logS7Worker(tag, payload) {
  console.info(`[S7][${tag}]`, payload);
}

/** Logs rastreáveis importação histórica ML (Mission Control). */
function logS7MlSalesHistory(tag, payload) {
  console.info(tag, payload);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} row
 */
async function tryWriteSalesImportCoverage(supabase, row) {
  try {
    await upsertMarketplaceSalesImportCoverage(supabase, row);
    logS7MlSalesHistory("[S7_ML_SALES_HISTORY_COVERAGE]", { ok: true, source_job_id: row.source_job_id, status: row.status });
  } catch (e) {
    logS7MlSalesHistory("[S7_ML_SALES_HISTORY_COVERAGE]", {
      ok: false,
      source_job_id: row.source_job_id ?? null,
      error_message: e?.message ? String(e.message) : String(e),
    });
  }
}

/** @param {string} jobType */
function pipelineStepRank(jobType) {
  return PIPELINE_STEP_RANK[jobType] ?? 50;
}

/** @param {Record<string, unknown>} job */
function jobEffectivePriority(job) {
  const meta =
    job.metadata && typeof job.metadata === "object" && !Array.isArray(job.metadata)
      ? /** @type {Record<string, unknown>} */ (job.metadata)
      : {};
  const raw = job.priority ?? meta.priority;
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(n)) return n;
  return 0;
}

function resolveOrderDetailConcurrency() {
  return Math.min(
    20,
    Math.max(1, parseInt(process.env.ML_ORDER_DETAIL_CONCURRENCY_PER_ACCOUNT || "5", 10) || 5)
  );
}

/**
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, concurrency, fn) {
  const results = /** @type {R[]} */ (new Array(items.length));
  let nextIndex = 0;
  const workers = Math.min(concurrency, items.length);

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** @param {string | null | undefined} raw */
function parseSalesCursor(raw) {
  try {
    const o = raw ? JSON.parse(raw) : {};
    const search_offset = Number.isFinite(Number(o.search_offset)) ? Number(o.search_offset) : 0;
    const idx_in_page = Number.isFinite(Number(o.idx_in_page)) ? Number(o.idx_in_page) : 0;
    const seller_id = o.seller_id != null ? String(o.seller_id).trim() : null;
    return { search_offset, idx_in_page, seller_id };
  } catch {
    return { search_offset: 0, idx_in_page: 0, seller_id: null };
  }
}

/** @param {{ search_offset: number; idx_in_page: number; seller_id: string | null }} c */
function serializeSalesCursor(c) {
  return JSON.stringify({
    search_offset: c.search_offset,
    idx_in_page: c.idx_in_page,
    seller_id: c.seller_id,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {number} limit
 */
async function fetchJobsPool(supabase, limit = 400) {
  console.info("[ML_ONBOARDING_SYNC_WORKER_QUERY]", {
    table: "marketplace_account_sync_jobs",
    status_filter: ["pending", "running"],
    marketplace_filter: ML_MARKETPLACE_SLUG,
    order_by: "created_at asc",
    limit,
  });
  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("*")
    .in("status", ["pending", "running"])
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/**
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @param {string} label
 */
async function withTimeout(promise, timeoutMs, label) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout_${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Move jobs running "órfãos" para erro para não ficar infinito.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function markStaleRunningJobsAsError(supabase) {
  const cutoffIso = new Date(Date.now() - RUNNING_STALE_TIMEOUT_MS).toISOString();
  const { data: rows, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("id,job_type,marketplace_account_id,updated_at")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("status", "running")
    .lt("updated_at", cutoffIso)
    .limit(100);
  if (error) {
    console.warn("[ML_INITIAL_SYNC_STALE_RUNNING_SCAN_WARN]", { message: error.message });
    return 0;
  }
  const staleRows = Array.isArray(rows) ? rows : [];
  let moved = 0;
  for (const row of staleRows) {
    const nowIso = new Date().toISOString();
    const msg = `stale_running_timeout>${RUNNING_STALE_TIMEOUT_MS}ms`;
    const { error: updErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .update({
        status: "error",
        finished_at: nowIso,
        updated_at: nowIso,
        error_message: msg,
      })
      .eq("id", row.id)
      .eq("status", "running");
    if (updErr) {
      console.warn("[ML_INITIAL_SYNC_STALE_RUNNING_UPDATE_WARN]", {
        job_id: row.id,
        message: updErr.message,
      });
      continue;
    }
    moved += 1;
    logS7Drain("marketplace-sync-drain-stale-recovered", {
      jobId: row.id ?? null,
      jobType: row.job_type ?? null,
      marketplaceAccountId: row.marketplace_account_id ?? null,
      sellerCompanyId: null,
      status: "error",
      progress_current: null,
      progress_total: null,
      cursor: null,
      elapsedMs: 0,
      stale_timeout_ms: RUNNING_STALE_TIMEOUT_MS,
    });
    console.warn("[ML_INITIAL_SYNC_STALE_RUNNING_MARKED_ERROR]", {
      job_id: row.id,
      job_type: row.job_type ?? null,
      marketplace_account_id: row.marketplace_account_id ?? null,
      updated_at: row.updated_at ?? null,
      stale_timeout_ms: RUNNING_STALE_TIMEOUT_MS,
    });
  }
  return moved;
}

/**
 * Último status conhecido por conta + job_type (lista ordenada por created_at desc).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} accountIds
 * @returns {Promise<Record<string, string>>}
 */
async function loadLatestJobStatusMap(supabase, accountIds) {
  /** @type {Record<string, string>} */
  const map = {};
  if (!accountIds.length) return map;

  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id,job_type,status,created_at")
    .in("marketplace_account_id", accountIds)
    .in("job_type", ML_ALL_ACCOUNT_SYNC_JOB_TYPES)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) throw error;

  for (const row of data ?? []) {
    const aid = row.marketplace_account_id != null ? String(row.marketplace_account_id) : "";
    const jt = row.job_type != null ? String(row.job_type) : "";
    if (!aid || !jt) continue;
    const key = `${aid}:${jt}`;
    if (!(key in map)) {
      map[key] = String(row.status || "");
    }
  }

  return map;
}

/**
 * Pipeline onboarding: cada etapa só roda quando as anteriores estão `done`.
 * @param {Record<string, unknown>} job
 * @param {Record<string, string>} statusMap
 */
/**
 * Motivo pelo qual o job não entra na fila elegível (null = pode rodar).
 * @param {Record<string, unknown>} job
 * @param {Record<string, string>} statusMap
 * @returns {string | null}
 */
function prerequisiteBlockReason(job, statusMap) {
  const acc = String(job.marketplace_account_id || "");
  const needDone = (jt) => statusMap[`${acc}:${jt}`] === "done";
  const salesHotDone = () => ML_SALES_HOT_TYPES.some((jt) => needDone(jt));
  const listingsDone = () => ML_LISTINGS_TYPES.some((jt) => needDone(jt));
  const customersHotDone = () => ML_CUSTOMERS_TYPES.some((jt) => needDone(jt));

  const t = String(job.job_type || "");
  if (t === "ml_initial_sales_recent" || t === "ml_initial_sales_history") return null;

  if (t === "ml_initial_listings_current" || t === "ml_initial_listings") {
    return salesHotDone() ? null : "blocked_until_ml_sales_hot_done";
  }
  if (t === "ml_initial_fees") {
    if (!salesHotDone()) return "blocked_until_ml_sales_hot_done";
    if (!listingsDone()) return "blocked_until_ml_listings_done";
    return null;
  }
  if (t === "ml_initial_products") {
    if (!salesHotDone()) return "blocked_until_ml_sales_hot_done";
    if (!listingsDone()) return "blocked_until_ml_listings_done";
    if (!needDone("ml_initial_fees")) return "blocked_until_ml_initial_fees_done";
    return null;
  }
  if (t === "ml_initial_customers_recent" || t === "ml_initial_customers") {
    if (!salesHotDone()) return "blocked_until_ml_sales_hot_done";
    if (!listingsDone()) return "blocked_until_ml_listings_done";
    if (!needDone("ml_initial_fees")) return "blocked_until_ml_initial_fees_done";
    if (!needDone("ml_initial_products")) return "blocked_until_ml_initial_products_done";
    return null;
  }
  if (t === "ml_enable_webhook_monitoring") {
    if (!salesHotDone()) return "blocked_until_ml_sales_hot_done";
    if (!listingsDone()) return "blocked_until_ml_listings_done";
    if (!needDone("ml_initial_fees")) return "blocked_until_ml_initial_fees_done";
    if (!needDone("ml_initial_products")) return "blocked_until_ml_initial_products_done";
    if (!customersHotDone()) return "blocked_until_ml_customers_hot_done";
    return null;
  }
  if (t === "ml_historical_sales_backfill") {
    return salesHotDone() ? null : "blocked_until_ml_sales_hot_done";
  }
  if (t === "ml_historical_customers_backfill") {
    return customersHotDone() ? null : "blocked_until_ml_customers_hot_done";
  }
  if (t === "ml_sales_enrichment_backfill") {
    return salesHotDone() ? null : "blocked_until_ml_sales_hot_done";
  }
  return `unsupported_or_unknown_job_type:${t || "empty"}`;
}

/**
 * Jobs ML pendentes/em execução por conta (visão worker).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} accountIds
 */
async function fetchPendingOrdersV2WebhookCountByAccount(supabase, accountIds) {
  /** @type {Record<string, number>} */
  const map = {};
  const ids = accountIds.map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from("ml_webhook_events")
    .select("marketplace_account_id")
    .in("marketplace_account_id", ids)
    .eq("topic", "orders_v2")
    .in("status", ["pending", "processing"])
    .limit(1000);
  if (error) {
    console.warn("[sales-sync] webhook_backlog_query_error", { message: error.message });
    return map;
  }
  for (const row of data || []) {
    const id = String(row.marketplace_account_id || "");
    if (!id) continue;
    map[id] = (map[id] || 0) + 1;
  }
  return map;
}

/**
 * Jobs ML pendentes/em execução por conta (visão worker).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} accountIds
 */
async function fetchActiveMlJobCountsByAccount(supabase, accountIds) {
  /** @type {Record<string, number>} */
  const map = {};
  const ids = accountIds.map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .in("marketplace_account_id", ids)
    .in("status", ["pending", "running"]);
  if (error) {
    console.warn("[sales-sync] active_job_count_query_error", { message: error.message });
    return map;
  }
  for (const row of data || []) {
    const id = String(row.marketplace_account_id || "");
    if (!id) continue;
    map[id] = (map[id] || 0) + 1;
  }
  return map;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, string>} statusMap
 * @param {Record<string, number>} [webhookBacklogByAccount]
 */
function sortEligibleJobs(rows, statusMap, webhookBacklogByAccount = {}) {
  const webhookPenaltyFor = (job) => {
    const aid = job.marketplace_account_id != null ? String(job.marketplace_account_id).trim() : "";
    const backlog = aid ? webhookBacklogByAccount[aid] || 0 : 0;
    if (backlog <= 0) return 0;
    const jobType = String(job.job_type || "");
    if (jobType === "ml_historical_sales_backfill" || jobType === "ml_initial_sales_history") return 1000;
    if (jobType === "ml_initial_listings" || jobType === "ml_initial_listings_current") return 100;
    if (jobType === "ml_initial_fees" || jobType === "ml_initial_products") return 50;
    return 0;
  };

  const filtered = rows.filter((j) => prerequisiteBlockReason(j, statusMap) == null);
  filtered.sort((a, b) => {
    const penaltyA = webhookPenaltyFor(a);
    const penaltyB = webhookPenaltyFor(b);
    if (penaltyA !== penaltyB) return penaltyA - penaltyB;
    const sa = String(a.status || "").toLowerCase();
    const sb = String(b.status || "").toLowerCase();
    const ua = new Date(/** @type {string} */ (a.updated_at || a.created_at || 0)).getTime();
    const ub = new Date(/** @type {string} */ (b.updated_at || b.created_at || 0)).getTime();
    const staleA = sa === "running" && Number.isFinite(ua) ? Date.now() - ua > RUNNING_STALE_TIMEOUT_MS / 2 : false;
    const staleB = sb === "running" && Number.isFinite(ub) ? Date.now() - ub > RUNNING_STALE_TIMEOUT_MS / 2 : false;
    const statusRank = (status, stale) => {
      if (status === "running" && stale) return 0;
      if (status === "running") return 1;
      if (status === "pending") return 2;
      return 9;
    };
    const rsA = statusRank(sa, staleA);
    const rsB = statusRank(sb, staleB);
    if (rsA !== rsB) return rsA - rsB;
    const pra = jobEffectivePriority(a);
    const prb = jobEffectivePriority(b);
    if (pra !== prb) return prb - pra;
    const stepA = pipelineStepRank(String(a.job_type || ""));
    const stepB = pipelineStepRank(String(b.job_type || ""));
    if (stepA !== stepB) return stepA - stepB;
    return ua - ub;
  });
  return filtered;
}

/**
 * Até um job por conta por onda (evita conflito paralelo na mesma marketplace_account_id).
 * @param {Record<string, unknown>[]} sortedEligible
 * @param {number} maxPick
 */
function pickJobsDistinctAccounts(sortedEligible, maxPick) {
  /** @type {Record<string, unknown>[]} */
  const picked = [];
  const seen = new Set();
  for (const j of sortedEligible) {
    const aid = j.marketplace_account_id != null ? String(j.marketplace_account_id).trim() : "";
    if (!aid || seen.has(aid)) continue;
    seen.add(aid);
    picked.push(j);
    if (picked.length >= maxPick) break;
  }
  return picked;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {Record<string, unknown>} metaPatch
 */
async function completeStubJob(supabase, job, metaPatch) {
  const nowIso = new Date().toISOString();
  const metaBase =
    typeof job.metadata === "object" && job.metadata && !Array.isArray(job.metadata)
      ? /** @type {Record<string, unknown>} */ (job.metadata)
      : {};

  const { error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "done",
      finished_at: nowIso,
      updated_at: nowIso,
      progress_current: 1,
      progress_total: 1,
      metadata: { ...metaBase, ...metaPatch },
    })
    .eq("id", job.id);

  if (error) {
    console.error("[marketplaceAccountSyncWorker] complete_stub_failed", error);
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number; batchDetails: number; salesPageLimit?: number }} opts
 */
async function processMlSalesBatchJob(supabase, job, opts) {
  const { deadlineMs, batchDetails } = opts;
  const pageLimit = opts.salesPageLimit ?? resolveSalesSearchPageLimit();
  const heartbeatEvery = resolveSalesProgressHeartbeatEvery();
  let processedInThisRun = 0;
  let ordersSinceHeartbeat = 0;

  const accountId = String(job.marketplace_account_id || "");
  const userId = String(job.user_id || "");
  let jRow = await ensureMarketplaceSyncJobRunning(supabase, job);

  console.info("[sales-sync] job_start", {
    marketplace: ML_MARKETPLACE_SLUG,
    marketplace_account_id: String(job.marketplace_account_id || ""),
    seller_company_id: job.seller_company_id != null ? String(job.seller_company_id) : null,
    user_id: userId,
    job_id: String(jRow.id),
    job_type: String(jRow.job_type || ""),
  });

  const { data: accountRow, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id,user_id,seller_company_id,external_seller_id,status")
    .eq("id", accountId)
    .maybeSingle();

  if (accErr) throw accErr;
  if (!accountRow?.id || String(accountRow.status || "").toLowerCase() !== "active") {
    await failMarketplaceSyncJob(
      supabase,
      String(jRow.id),
      "Conta marketplace inativa ou ausente.",
      "[ML_INITIAL_SALES_SYNC_ERROR]"
    );
    return { stopped: true, processedInThisRun: 0 };
  }

  let accessToken;
  try {
    accessToken = await getValidMLToken(userId, { marketplaceAccountId: accountId });
  } catch (e) {
    await failMarketplaceSyncJob(
      supabase,
      String(jRow.id),
      e?.message ? String(e.message) : "token_ml",
      "[ML_INITIAL_SALES_SYNC_ERROR]"
    );
    return { stopped: true, processedInThisRun: 0 };
  }

  console.info("[worker] marketplace_account_processed", {
    marketplace_account_id: accountId,
    user_id: userId,
    job_id: String(jRow.id),
    job_type: String(jRow.job_type || ""),
    phase: "ml_sales_batch_token_ready",
  });

  let sellerId =
    accountRow.external_seller_id != null ? String(accountRow.external_seller_id).trim() : "";
  try {
    const me = await fetchMercadoLibreUserMe(accessToken, { marketplaceAccountId: accountId });
    const meId = me?.id != null ? String(me.id).trim() : "";
    if (meId) sellerId = meId;
  } catch (e) {
    console.warn("[ML_INITIAL_SALES_SYNC_BATCH] users_me_failed", { message: e?.message });
  }

  if (!sellerId) {
    await failMarketplaceSyncJob(
      supabase,
      String(jRow.id),
      "seller_id indisponível.",
      "[ML_INITIAL_SALES_SYNC_ERROR]"
    );
    return { stopped: true, processedInThisRun: 0 };
  }

  const sellerCompanyFromAcc =
    accountRow.seller_company_id != null ? String(accountRow.seller_company_id) : null;

  console.info("[sales-sync] account_start", {
    marketplace: ML_MARKETPLACE_SLUG,
    marketplace_account_id: accountId,
    seller_company_id: sellerCompanyFromAcc,
    user_id: userId,
    external_seller_id: sellerId,
    job_id: jRow.id,
    job_type: String(jRow.job_type || ""),
  });

  let cursor = parseSalesCursor(
    jRow.last_cursor != null && typeof jRow.last_cursor === "string" ? jRow.last_cursor : null
  );
  cursor.seller_id = sellerId;

  console.info("[ML_INITIAL_SALES_SYNC_START]", {
    job_id: jRow.id,
    marketplace_account_id: accountId,
    cursor,
  });
  console.info("[ML_INITIAL_SALES_HISTORY_START]", {
    job_id: jRow.id,
    marketplace_account_id: accountId,
    seller_id: sellerId,
    cursor,
  });
  console.info("[ML_SALES_SYNC_START]", {
    job_id: jRow.id,
    marketplace_account_id: accountId,
    seller_id: sellerId,
    cursor,
  });

  const salesJobType = String(jRow.job_type || "");
  const metaJob =
    jRow.metadata && typeof jRow.metadata === "object" && !Array.isArray(jRow.metadata)
      ? /** @type {Record<string, unknown>} */ (jRow.metadata)
      : {};

  let rangeFrom = "";
  let rangeTo = new Date().toISOString();

  if (salesJobType === "ml_historical_sales_backfill") {
    rangeFrom =
      metaJob.date_from != null && String(metaJob.date_from).trim() !== ""
        ? String(metaJob.date_from).trim()
        : "";
    if (metaJob.date_to != null && String(metaJob.date_to).trim() !== "") {
      rangeTo = String(metaJob.date_to).trim();
    }
    console.info("[historical-sales-sync] window_start", {
      marketplace: ML_MARKETPLACE_SLUG,
      marketplace_account_id: accountId,
      seller_company_id: sellerCompanyFromAcc,
      user_id: userId,
      external_seller_id: sellerId,
      job_id: jRow.id,
      window_start: rangeFrom,
      window_end: rangeTo,
      window_index: metaJob.window_index ?? null,
    });
    if (!rangeFrom) {
      await failMarketplaceSyncJob(
        supabase,
        String(jRow.id),
        "Backfill histórico sem date_from em metadata.",
        "[ML_HISTORICAL_SALES_SYNC_ERROR]"
      );
      return { stopped: true, processedInThisRun: 0 };
    }
  } else if (salesJobType === "ml_initial_sales_recent") {
    const rd = resolveMlInitialRecentDays();
    rangeFrom = new Date(Date.now() - rd * 86400000).toISOString();
  } else if (salesJobType === "ml_initial_sales_history") {
    if (metaJob.import_full_history === true) {
      rangeFrom = new Date(Date.now() - ML_INITIAL_ORDERS_LOOKBACK_DAYS * 86400000).toISOString();
    } else {
      const rd = resolveMlInitialRecentDays();
      rangeFrom = new Date(Date.now() - rd * 86400000).toISOString();
    }
  } else {
    const rd = resolveMlInitialRecentDays();
    rangeFrom = new Date(Date.now() - rd * 86400000).toISOString();
  }

  console.info("[ML_ORDERS_FETCH_RANGE]", {
    job_id: jRow.id,
    marketplace_account_id: accountId,
    job_type: salesJobType,
    date_from: rangeFrom,
    date_to: rangeTo,
    recent_days:
      salesJobType === "ml_historical_sales_backfill" ? null : resolveMlInitialRecentDays(),
    legacy_full_history: metaJob.import_full_history === true,
  });

  let processedTotal = Number(jRow.progress_current ?? 0) || 0;
  let progressTotal = jRow.progress_total != null ? Number(jRow.progress_total) : null;

  /** @type {{ synced_count: number; created_count: number; updated_count: number; skipped_count: number; skipped_cancelled_or_unavailable_count: number; errors: string[] }} */
  const summaryStub = {
    synced_count: 0,
    created_count: 0,
    updated_count: 0,
    skipped_count: 0,
    skipped_cancelled_or_unavailable_count: 0,
    errors: [],
  };
  let partialErrors = 0;
  let consecutiveEmptyPageSkips = 0;
  let cumulativeRowsFromSearch = 0;
  const mLEmptyPageMaxSkips = Math.min(
    50,
    Math.max(4, parseInt(process.env.ML_SALES_EMPTY_PAGE_MAX_SKIPS || "24", 10) || 24)
  );

  const safePatchProgress = async (patch, reason) => {
    try {
      await patchMarketplaceSyncJob(supabase, String(jRow.id), patch);
    } catch (e) {
      console.warn("[ML_INITIAL_SALES_SYNC_PROGRESS_PATCH_WARN]", {
        job_id: jRow.id,
        reason,
        message: e?.message ?? String(e),
      });
    }
  };

  const metaRowBase = () =>
    typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
      ? /** @type {Record<string, unknown>} */ ({ ...jRow.metadata })
      : {};

  const buildCoverageRow = (status, finishedAt) => {
    const dup = Number(summaryStub.updated_count) || 0;
    const saved = (Number(summaryStub.created_count) || 0) + dup;
    const skippedBody =
      (Number(summaryStub.skipped_count) || 0) + (Number(summaryStub.skipped_cancelled_or_unavailable_count) || 0);
    return {
      user_id: userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplace_account_id: accountId,
      seller_company_id: sellerCompanyFromAcc,
      external_seller_id: sellerId,
      sync_type: salesJobType,
      status,
      date_from: rangeFrom,
      date_to: rangeTo,
      api_total: progressTotal,
      fetched_total: cumulativeRowsFromSearch,
      saved_total: saved,
      duplicate_total: dup,
      skipped_total: skippedBody,
      error_total: partialErrors,
      last_offset: cursor.search_offset,
      last_error_code: null,
      last_error_message: null,
      started_at: jRow.started_at ?? null,
      finished_at: finishedAt ?? null,
      source_job_id: jRow.id,
      metadata: {
        idx_in_page: cursor.idx_in_page,
        last_cursor: serializeSalesCursor(cursor),
      },
    };
  };

  const flushCoverage = async (status, finishedAt) => {
    await tryWriteSalesImportCoverage(supabase, buildCoverageRow(status, finishedAt));
  };

  while (Date.now() < deadlineMs) {
    await safePatchProgress(
      {
        metadata: {
          ...metaRowBase(),
          phase: salesJobType === "ml_historical_sales_backfill" ? "historical_sales_window" : "sales_recent",
          sync_job_kind: salesJobType,
          last_orders_search_started_at: new Date().toISOString(),
        },
      },
      "before_orders_search"
    );
    const tSearch0 = Date.now();
    console.info("[sales-sync] fetch_orders_start", {
      marketplace: ML_MARKETPLACE_SLUG,
      marketplace_account_id: accountId,
      seller_company_id: sellerCompanyFromAcc,
      user_id: userId,
      external_seller_id: sellerId,
      job_id: jRow.id,
      job_type: salesJobType,
      window_start: rangeFrom,
      window_end: rangeTo,
      offset: cursor.search_offset,
    });
    console.info("[ML_ORDERS_FETCH_START]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      seller_id: sellerId,
      offset: cursor.search_offset,
    });
    let page;
    try {
      logS7MlSalesHistory("[S7_ML_SALES_HISTORY_BATCH_START]", {
        user_id: userId,
        marketplace_account_id: accountId,
        external_seller_id: sellerId,
        job_id: jRow.id,
        date_from: rangeFrom,
        date_to: rangeTo,
        offset: cursor.search_offset,
        limit: pageLimit,
        batch_count: batchDetails,
        sort: resolveMlOrdersSearchSort(),
      });
      page = await searchSellerOrdersPage(accessToken, sellerId, cursor.search_offset, pageLimit, {
        dateFrom: rangeFrom,
        dateTo: rangeTo,
        marketplaceAccountId: accountId,
        sort: resolveMlOrdersSearchSort(),
      });
    } catch (e) {
      const em = e?.message ? String(e.message) : String(e);
      const code = e && typeof e === "object" && "status" in e ? String(/** @type {{ status?: number }} */ (e).status) : "orders_search_fetch_error";
      logS7MlSalesHistory("[S7_ML_SALES_HISTORY_BATCH_ERROR]", {
        user_id: userId,
        marketplace_account_id: accountId,
        external_seller_id: sellerId,
        date_from: rangeFrom,
        date_to: rangeTo,
        offset: cursor.search_offset,
        limit: pageLimit,
        error_code: code,
        error_message: em.slice(0, 500),
        job_id: jRow.id,
      });
      await tryWriteSalesImportCoverage(supabase, {
        ...buildCoverageRow("error", new Date().toISOString()),
        last_error_code: code,
        last_error_message: em.slice(0, 2000),
      });
      await failMarketplaceSyncJob(supabase, String(jRow.id), em, "[ML_HISTORICAL_SALES_SYNC_ERROR]");
      return { stopped: true, processedInThisRun, progress_current: processedTotal, progress_total: progressTotal };
    }

    if (progressTotal == null && page.paging?.total != null) {
      progressTotal = Number(page.paging.total);
    }

    const orderIds = page.orderIds || [];
    cumulativeRowsFromSearch += orderIds.length;
    console.info("[sales-sync] fetch_orders_ok", {
      marketplace: ML_MARKETPLACE_SLUG,
      marketplace_account_id: accountId,
      seller_company_id: sellerCompanyFromAcc,
      user_id: userId,
      external_seller_id: sellerId,
      job_id: jRow.id,
      job_type: salesJobType,
      window_start: rangeFrom,
      window_end: rangeTo,
      offset: cursor.search_offset,
      batch_count: orderIds.length,
      duration_ms: Date.now() - tSearch0,
    });
    console.info("[ML_ORDERS_FETCH_DONE]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      fetched: orderIds.length,
      paging_total: page.paging?.total ?? null,
      offset: cursor.search_offset,
    });
    console.info("[ML_INITIAL_SALES_HISTORY_FETCH_DONE]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      fetched: orderIds.length,
      paging_total: page.paging?.total ?? null,
      offset: cursor.search_offset,
    });

    console.info("[ML_INITIAL_SALES_SYNC_BATCH]", {
      job_id: jRow.id,
      search_offset: cursor.search_offset,
      idx_in_page: cursor.idx_in_page,
      page_orders: orderIds.length,
      paging_total: page.paging?.total ?? null,
      processed_so_far: processedTotal,
    });

    const apiTotalRaw = Number(page.paging?.total);
    const apiTotal = Number.isFinite(apiTotalRaw) ? apiTotalRaw : 0;

    logS7MlSalesHistory("[S7_ML_SALES_HISTORY_BATCH_OK]", {
      user_id: userId,
      marketplace_account_id: accountId,
      external_seller_id: sellerId,
      job_id: jRow.id,
      date_from: rangeFrom,
      date_to: rangeTo,
      offset: cursor.search_offset,
      limit: pageLimit,
      batch_count: orderIds.length,
      api_total: progressTotal ?? apiTotal,
      saved_count: (Number(summaryStub.created_count) || 0) + (Number(summaryStub.updated_count) || 0),
      skipped_duplicate_count: 0,
      skipped_cancelled_or_unavailable_count: summaryStub.skipped_cancelled_or_unavailable_count,
    });

    logS7MlSalesHistory("[S7_ML_SALES_HISTORY_PROGRESS]", {
      user_id: userId,
      marketplace_account_id: accountId,
      external_seller_id: sellerId,
      job_id: jRow.id,
      date_from: rangeFrom,
      date_to: rangeTo,
      offset: cursor.search_offset,
      limit: pageLimit,
      progress_current: processedTotal,
      progress_total: progressTotal,
      api_total: progressTotal ?? apiTotal,
      cumulative_rows_from_search: cumulativeRowsFromSearch,
    });

    if (orderIds.length > 0) {
      consecutiveEmptyPageSkips = 0;
    }

    if (orderIds.length === 0) {
      consecutiveEmptyPageSkips += 1;
      const apiTotalOk = apiTotal > 0;
      const incomplete =
        apiTotalOk && processedTotal < apiTotal && cursor.search_offset < apiTotal;

      if (incomplete && consecutiveEmptyPageSkips <= mLEmptyPageMaxSkips) {
        const prevOff = cursor.search_offset;
        cursor.search_offset = Math.min(apiTotal, prevOff + pageLimit);
        cursor.idx_in_page = 0;
        logS7MlSalesHistory("[S7_ML_SALES_HISTORY_BATCH_ERROR]", {
          user_id: userId,
          marketplace_account_id: accountId,
          external_seller_id: sellerId,
          job_id: jRow.id,
          date_from: rangeFrom,
          date_to: rangeTo,
          offset: prevOff,
          limit: pageLimit,
          batch_count: 0,
          api_total: apiTotal,
          saved_count: (Number(summaryStub.created_count) || 0) + (Number(summaryStub.updated_count) || 0),
          skipped_duplicate_count: 0,
          skipped_cancelled_or_unavailable_count: summaryStub.skipped_cancelled_or_unavailable_count,
          error_code: "ml_orders_empty_page_incomplete",
          error_message: `empty_page_advance_offset ${prevOff}->${cursor.search_offset} skip=${consecutiveEmptyPageSkips}`,
        });
        await safePatchProgress(
          {
            last_cursor: serializeSalesCursor(cursor),
            progress_total: progressTotal,
            progress_current: processedTotal,
            metadata: {
              ...metaRowBase(),
              phase: salesJobType === "ml_historical_sales_backfill" ? "historical_sales_window" : "sales_recent",
              sync_job_kind: salesJobType,
              ml_orders_empty_page_skip: consecutiveEmptyPageSkips,
              ml_orders_empty_page_from: prevOff,
              ml_orders_empty_page_to: cursor.search_offset,
            },
          },
          "empty_page_anomaly_advance"
        );
        await flushCoverage("running", null);
        continue;
      }

      if (incomplete && consecutiveEmptyPageSkips > mLEmptyPageMaxSkips) {
        const fatalMsg = `Histórico ML: resposta vazia repetida (API total=${apiTotal}, importados=${processedTotal}).`;
        logS7MlSalesHistory("[S7_ML_SALES_HISTORY_BATCH_ERROR]", {
          user_id: userId,
          marketplace_account_id: accountId,
          external_seller_id: sellerId,
          job_id: jRow.id,
          date_from: rangeFrom,
          date_to: rangeTo,
          offset: cursor.search_offset,
          limit: pageLimit,
          api_total: apiTotal,
          error_code: "ml_orders_empty_page_exhausted",
          error_message: fatalMsg,
        });
        await tryWriteSalesImportCoverage(supabase, {
          ...buildCoverageRow("error", new Date().toISOString()),
          last_error_code: "ml_orders_empty_page_exhausted",
          last_error_message: fatalMsg.slice(0, 2000),
        });
        await failMarketplaceSyncJob(supabase, String(jRow.id), fatalMsg, "[ML_HISTORICAL_SALES_SYNC_ERROR]");
        return { stopped: true, processedInThisRun, progress_current: processedTotal, progress_total: progressTotal };
      }

      const partialSummaryMsg =
        partialErrors > 0 ? `completed_with_partial_errors:${partialErrors}` : null;
      const metaDone = {
        ...metaRowBase(),
        phase: salesJobType === "ml_historical_sales_backfill" ? "historical_sales_window" : "sales_recent",
        sync_job_kind: salesJobType,
        errors_count: partialErrors,
        errors_sample: summaryStub.errors.slice(-20),
        ml_sales_import_api_total: progressTotal ?? apiTotal,
        ml_sales_import_saved: (Number(summaryStub.created_count) || 0) + (Number(summaryStub.updated_count) || 0),
        ml_sales_import_skipped_cancelled: summaryStub.skipped_cancelled_or_unavailable_count,
        ml_sales_api_total_divergence:
          apiTotalOk && processedTotal < apiTotal
            ? { api_total: apiTotal, imported: processedTotal, note: "paginação concluída; totais API vs persistidos divergem" }
            : null,
      };
      await completeMarketplaceSyncJob(supabase, String(jRow.id), {
        progress_total: progressTotal ?? processedTotal,
        progress_current: processedTotal,
        last_cursor: null,
        last_synced_at: new Date().toISOString(),
        error_message: partialSummaryMsg,
        metadata: metaDone,
      });
      console.info(
        salesJobType === "ml_historical_sales_backfill" ? "[historical-sales-sync] window_done" : "[sales-sync] account_done",
        {
          marketplace: ML_MARKETPLACE_SLUG,
          marketplace_account_id: accountId,
          seller_company_id: sellerCompanyFromAcc,
          user_id: userId,
          external_seller_id: sellerId,
          job_id: jRow.id,
          job_type: salesJobType,
          window_start: rangeFrom,
          window_end: rangeTo,
          processed_total: processedTotal,
        }
      );
      const enqueueHistoricalAfterHot =
        salesJobType !== "ml_historical_sales_backfill" &&
        (salesJobType === "ml_initial_sales_recent" ||
          (salesJobType === "ml_initial_sales_history" && metaJob.import_full_history !== true));
      if (enqueueHistoricalAfterHot) {
        try {
          await enqueueHistoricalSalesBackfillJobs(supabase, {
            userId,
            marketplaceAccountId: accountId,
            sellerCompanyId: sellerCompanyFromAcc,
            marketplace: ML_MARKETPLACE_SLUG,
          });
        } catch (e) {
          console.warn("[ML_HISTORICAL_SALES_BACKFILL_ENQUEUE_WARN]", {
            job_id: jRow.id,
            marketplace_account_id: accountId,
            message: e?.message ?? String(e),
          });
        }
      }
      logS7MlSalesHistory("[S7_ML_SALES_HISTORY_COMPLETED]", {
        user_id: userId,
        marketplace_account_id: accountId,
        external_seller_id: sellerId,
        job_id: jRow.id,
        date_from: rangeFrom,
        date_to: rangeTo,
        api_total: progressTotal ?? apiTotal,
        saved_count: (Number(summaryStub.created_count) || 0) + (Number(summaryStub.updated_count) || 0),
        skipped_duplicate_count: 0,
        skipped_cancelled_or_unavailable_count: summaryStub.skipped_cancelled_or_unavailable_count,
        error_total: partialErrors,
        reason: "orders_page_empty_or_exhausted",
      });
      await flushCoverage("done", new Date().toISOString());
      console.info("[ML_INITIAL_SALES_SYNC_DONE]", {
        job_id: jRow.id,
        marketplace_account_id: accountId,
        processedTotal,
      });
      console.info("[ML_SALES_SYNC_FINISHED]", {
        job_id: jRow.id,
        marketplace_account_id: accountId,
        processed_total: processedTotal,
      });
      console.info("[ML_INITIAL_SALES_HISTORY_FINISHED]", {
        job_id: jRow.id,
        marketplace_account_id: accountId,
        processed_total: processedTotal,
        reason: "orders_page_empty",
      });
      return {
        stopped: true,
        done: true,
        processedInThisRun,
        progress_current: processedTotal,
        progress_total: progressTotal,
      };
    }

    if (cursor.idx_in_page >= orderIds.length) {
      cursor.search_offset = nextOrdersSearchOffset(cursor.search_offset, pageLimit, orderIds.length);
      cursor.idx_in_page = 0;
      await patchMarketplaceSyncJob(supabase, String(jRow.id), {
        last_cursor: serializeSalesCursor(cursor),
        progress_total: progressTotal,
        progress_current: processedTotal,
      });
      continue;
    }

    const slice = orderIds.slice(cursor.idx_in_page, cursor.idx_in_page + batchDetails);
    const nowIso = new Date().toISOString();
    let batchMaxCreated = null;

    const detailConcurrency = resolveOrderDetailConcurrency();
    const fetchedPairs = await mapLimit(slice, detailConcurrency, async (oid) => {
      try {
        const detail = await fetchOrderById(accessToken, oid, { marketplaceAccountId: accountId });
        return { oid, detail, err: null };
      } catch (e) {
        return { oid, detail: null, err: e };
      }
    });

    const slicePhase =
      salesJobType === "ml_historical_sales_backfill" ? "historical_sales_window" : "sales_recent";

    for (const pair of fetchedPairs) {
      const oid = pair.oid;
      const orderIndex = processedTotal + 1;
      console.info("[S7][ml-sales-sync-order-step]", {
        syncRunId: jRow.id,
        marketplaceAccountId: accountId,
        sellerCompanyId: sellerCompanyFromAcc,
        externalOrderId: String(oid),
        index: orderIndex,
        total: progressTotal,
        step: "fetch order",
        detailConcurrency,
      });

      if (pair.err) {
        const msg = pair.err?.message ? String(pair.err.message) : String(pair.err);
        console.error("[ML_INITIAL_SALES_SYNC_ERROR]", { job_id: jRow.id, order_id: oid, msg });
        console.error("[ML_SALES_SYNC_FAILED]", {
          job_id: jRow.id,
          marketplace_account_id: accountId,
          order_id: oid,
          message: msg,
        });
        summaryStub.errors.push(`${oid}: ${msg}`);
        partialErrors += 1;
        cursor.idx_in_page += 1;
        processedTotal += 1;
        processedInThisRun += 1;
        if (progressTotal != null && processedTotal > progressTotal) processedTotal = progressTotal;
        ordersSinceHeartbeat += 1;
        const metaBaseErr =
          typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
            ? /** @type {Record<string, unknown>} */ (jRow.metadata)
            : {};
        await safePatchProgress({
          progress_total: progressTotal,
          progress_current: processedTotal,
          last_cursor: serializeSalesCursor(cursor),
          last_synced_at: new Date().toISOString(),
          metadata: {
            ...metaBaseErr,
            phase: slicePhase,
            sync_job_kind: salesJobType,
            errors_count: partialErrors,
            last_error_order_id: String(oid),
            last_error_message: msg.slice(0, 220),
            errors_sample: summaryStub.errors.slice(-20),
          },
        }, "after_fetch_error");
        ordersSinceHeartbeat = 0;
        continue;
      }

      const detail = pair.detail;
      if (!detail) {
        const msg = "detail_null";
        summaryStub.errors.push(`${oid}: ${msg}`);
        partialErrors += 1;
        cursor.idx_in_page += 1;
        processedTotal += 1;
        processedInThisRun += 1;
        if (progressTotal != null && processedTotal > progressTotal) processedTotal = progressTotal;
        ordersSinceHeartbeat += 1;
        await safePatchProgress(
          {
            progress_total: progressTotal,
            progress_current: processedTotal,
            last_cursor: serializeSalesCursor(cursor),
            last_synced_at: new Date().toISOString(),
            metadata: {
              ...metaRowBase(),
              phase: slicePhase,
              sync_job_kind: salesJobType,
              errors_count: partialErrors,
              last_error_order_id: String(oid),
              last_error_message: msg,
              errors_sample: summaryStub.errors.slice(-20),
            },
          },
          "after_detail_null"
        );
        ordersSinceHeartbeat = 0;
        continue;
      }

      const orderStatusRaw = detail.status != null ? String(detail.status).toLowerCase() : "";
      if (orderStatusRaw === "cancelled") {
        summaryStub.skipped_cancelled_or_unavailable_count += 1;
        cursor.idx_in_page += 1;
        processedTotal += 1;
        processedInThisRun += 1;
        if (progressTotal != null && processedTotal > progressTotal) processedTotal = progressTotal;
        ordersSinceHeartbeat += 1;
        const flushHb =
          ordersSinceHeartbeat >= heartbeatEvery || oid === slice[slice.length - 1];
        if (flushHb) {
          await safePatchProgress(
            {
              progress_total: progressTotal,
              progress_current: processedTotal,
              last_cursor: serializeSalesCursor(cursor),
              last_synced_at: new Date().toISOString(),
              metadata: {
                ...metaRowBase(),
                phase: slicePhase,
                sync_job_kind: salesJobType,
                errors_count: partialErrors,
                last_order_id: String(oid),
                last_order_index: orderIndex,
                last_skip_reason: "cancelled",
                errors_sample: summaryStub.errors.slice(-20),
              },
            },
            "after_order_cancelled_skip"
          );
          ordersSinceHeartbeat = 0;
        }
        continue;
      }

      const created =
        detail?.date_created != null && String(detail.date_created).trim() !== ""
          ? String(detail.date_created)
          : null;
      if (created && (!batchMaxCreated || Date.parse(created) > Date.parse(batchMaxCreated))) {
        batchMaxCreated = created;
      }

      try {
        console.info("[S7][ml-sales-sync-order-step]", {
          syncRunId: jRow.id,
          marketplaceAccountId: accountId,
          sellerCompanyId: sellerCompanyFromAcc,
          externalOrderId: String(oid),
          index: orderIndex,
          total: progressTotal,
          step: "persist order/items/customer/snapshot/metrics",
        });
        await withTimeout(
          applyMlOrderDetailToMarketplaceSales(
            supabase,
            userId,
            accountId,
            sellerCompanyFromAcc,
            detail,
            nowIso,
            summaryStub,
            accessToken,
            {
              syncRunId: String(jRow.id),
              orderIndex,
              total: progressTotal,
              syncType: salesJobType,
            },
            {
              syncType: salesJobType,
            }
          ),
          ORDER_PROCESS_TIMEOUT_MS,
          "process_order"
        );
        console.info("[sales-sync] persist_order_ok", {
          marketplace: ML_MARKETPLACE_SLUG,
          marketplace_account_id: accountId,
          seller_company_id: sellerCompanyFromAcc,
          user_id: userId,
          external_seller_id: sellerId,
          external_order_id: String(oid),
          job_id: jRow.id,
        });
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        console.error("[ML_INITIAL_SALES_SYNC_ERROR]", { job_id: jRow.id, order_id: oid, msg });
        console.error("[ML_SALES_SYNC_FAILED]", {
          job_id: jRow.id,
          marketplace_account_id: accountId,
          order_id: oid,
          message: msg,
        });
        summaryStub.errors.push(`${oid}: ${msg}`);
        partialErrors += 1;
      }

      cursor.idx_in_page += 1;
      processedTotal += 1;
      processedInThisRun += 1;
      if (progressTotal != null && processedTotal > progressTotal) processedTotal = progressTotal;
      ordersSinceHeartbeat += 1;
      const perOrderMetaBase =
        typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
          ? /** @type {Record<string, unknown>} */ (jRow.metadata)
          : {};
      const flushHeartbeat =
        ordersSinceHeartbeat >= heartbeatEvery || oid === slice[slice.length - 1];
      if (flushHeartbeat) {
        await safePatchProgress({
          progress_total: progressTotal,
          progress_current: processedTotal,
          last_cursor: serializeSalesCursor(cursor),
          last_synced_at: new Date().toISOString(),
          metadata: {
            ...perOrderMetaBase,
            phase: slicePhase,
            sync_job_kind: salesJobType,
            errors_count: partialErrors,
            last_order_id: String(oid),
            last_order_index: orderIndex,
            errors_sample: summaryStub.errors.slice(-20),
          },
        }, "after_order_processed");
        logS7Drain("marketplace-sync-drain-job-progress", {
          jobId: jRow.id ?? null,
          jobType: jRow.job_type ?? null,
          marketplaceAccountId: accountId,
          sellerCompanyId: sellerCompanyFromAcc,
          status: "running",
          progress_current: processedTotal,
          progress_total: progressTotal ?? null,
          cursor: serializeSalesCursor(cursor),
          elapsedMs: 0,
          heartbeat: true,
        });
        ordersSinceHeartbeat = 0;
      }
      console.info("[S7][ml-sales-sync-order-step]", {
        syncRunId: jRow.id,
        marketplaceAccountId: accountId,
        sellerCompanyId: sellerCompanyFromAcc,
        externalOrderId: String(oid),
        index: orderIndex,
        total: progressTotal,
        step: "update progress",
      });
    }

    if (batchMaxCreated) {
      try {
        await advanceMlSalesWatermark(supabase, accountId, batchMaxCreated, nowIso);
      } catch (wmErr) {
        console.error("[sales-sync] account_error", {
          marketplace: ML_MARKETPLACE_SLUG,
          marketplace_account_id: accountId,
          seller_company_id: sellerCompanyFromAcc,
          user_id: userId,
          external_seller_id: sellerId,
          job_id: jRow.id,
          error_code: "ml_sales_watermark_failed",
          error_message: wmErr?.message ? String(wmErr.message) : String(wmErr),
        });
      }
    }

    const metaBase =
      typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
        ? /** @type {Record<string, unknown>} */ (jRow.metadata)
        : {};

    await safePatchProgress({
      last_cursor: serializeSalesCursor(cursor),
      progress_total: progressTotal,
      progress_current: processedTotal,
      last_synced_at: nowIso,
      metadata: {
        ...metaBase,
        phase: slicePhase,
        sync_job_kind: salesJobType,
        errors_count: partialErrors,
        last_batch_orders: slice.length,
        errors_sample: summaryStub.errors.slice(-12),
      },
    }, "after_batch");
    await flushCoverage("running", null);
    console.info("[ML_ORDERS_UPSERT_DONE]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      batch_size: slice.length,
      processed_total: processedTotal,
    });
    console.info("[ML_INITIAL_SALES_HISTORY_UPSERT_DONE]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      batch_size: slice.length,
      processed_total: processedTotal,
    });

    jRow = {
      ...jRow,
      progress_total: progressTotal,
      progress_current: processedTotal,
      last_cursor: serializeSalesCursor(cursor),
      metadata: {
        ...metaBase,
        last_batch_orders: slice.length,
        errors_sample: summaryStub.errors.slice(-12),
      },
    };
  }

  await flushCoverage("running", null);
  return {
    stopped: false,
    processedInThisRun,
    progress_current: processedTotal,
    progress_total: progressTotal,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 */
async function processCustomersJob(supabase, job) {
  const j = await ensureMarketplaceSyncJobRunning(supabase, job);
  const userId = String(j.user_id || "");
  const accountId = String(j.marketplace_account_id || "");
  const sellerCompanyId =
    j.seller_company_id != null ? String(j.seller_company_id) : null;
  const jobType = String(j.job_type || "");
  const saleDateFrom =
    jobType === "ml_initial_customers_recent"
      ? new Date(Date.now() - resolveMlInitialRecentDays() * 86400000).toISOString()
      : null;

  console.info("[ML_INITIAL_CUSTOMERS_START]", {
    job_id: j.id,
    marketplace_account_id: accountId,
    saleDateFrom,
    job_type: jobType,
  });

  try {
    const ingestion = await ingestCustomersFromSales({
      supabase,
      userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplaceAccountId: accountId,
      sellerCompanyId,
      saleDateFrom,
    });

    const nowIso = new Date().toISOString();
    const metaBase =
      typeof j.metadata === "object" && j.metadata && !Array.isArray(j.metadata)
        ? /** @type {Record<string, unknown>} */ (j.metadata)
        : {};

    const processed = Number(ingestion?.processedOrders ?? 0) || 0;
    const created = Number(ingestion?.createdCustomers ?? 0) || 0;
    const updated = Number(ingestion?.updatedCustomers ?? 0) || 0;
    const withoutCustomer = Number(ingestion?.withoutCustomer ?? 0) || 0;
    const warnings = Array.isArray(ingestion?.errors)
      ? ingestion.errors.slice(-20)
      : [];
    const stepResult = {
      ok: true,
      step: "customers",
      processed,
      created,
      updated,
      without_customer: withoutCustomer,
      warnings,
    };

    await supabase
      .from("marketplace_account_sync_jobs")
      .update({
        status: "done",
        finished_at: nowIso,
        updated_at: nowIso,
        progress_current: processed || 1,
        progress_total: processed || 1,
        metadata: { ...metaBase, ingestion_summary: ingestion, step_result: stepResult },
      })
      .eq("id", j.id);

    console.info("[ML_INITIAL_CUSTOMERS_DONE]", { job_id: j.id, ingestion });
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    console.error("[ML_INITIAL_CUSTOMERS_ERROR]", { job_id: j.id, msg });
    await failMarketplaceSyncJob(supabase, String(j.id), msg, "[ML_INITIAL_CUSTOMERS_ERROR]");
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number }} runtime
 */
async function processFeesJob(supabase, job, runtime) {
  const j = await ensureMarketplaceSyncJobRunning(supabase, job);
  const userId = String(j.user_id || "");
  const accountId = String(j.marketplace_account_id || "");
  const sellerCompanyId = j.seller_company_id != null ? String(j.seller_company_id) : null;

  try {
    const result = await runMlInitialFeesSyncTurn(supabase, {
      userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplaceAccountId: accountId,
      sellerCompanyId,
      deadlineMs: runtime.deadlineMs,
    });

    await completeMarketplaceSyncJob(supabase, String(j.id), {
      progress_current: Number(result.processed ?? 0),
      progress_total: Number(result.processed ?? 0),
      last_synced_at: new Date().toISOString(),
      metadata: {
        step_result: result,
      },
    });
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    console.error("[ML_INITIAL_FEES_ERROR]", { job_id: j.id, msg });
    await failMarketplaceSyncJob(supabase, String(j.id), msg, "[ML_INITIAL_FEES_ERROR]");
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 */
async function processWebhookMonitoringJob(supabase, job) {
  const j = await ensureMarketplaceSyncJobRunning(supabase, job);
  const accountId = j.marketplace_account_id != null ? String(j.marketplace_account_id) : null;
  const nowIso = new Date().toISOString();
  console.info("[ML_INITIAL_WEBHOOK_MONITORING]", {
    job_id: j.id,
    marketplace_account_id: j.marketplace_account_id,
  });
  if (accountId) {
    const { error } = await supabase
      .from("marketplace_accounts")
      .update({
        updated_at: nowIso,
      })
      .eq("id", accountId);
    if (error) {
      console.warn("[ML_INITIAL_WEBHOOK_MONITORING_WARN]", {
        marketplace_account_id: accountId,
        message: error.message,
      });
    }
  }
  await completeStubJob(supabase, j, {
    monitoring: "webhook_pipeline_ready",
    ingest_path: "/api/ml/webhook",
    processor_job: "/api/jobs/ml-webhook-events",
    step_result: {
      ok: true,
      step: "webhook_monitoring",
      enabled: true,
      warnings: [],
    },
  });
}

const MULTI_TURN_RESUMABLE_JOB_TYPES = new Set([
  "ml_initial_sales_recent",
  "ml_initial_sales_history",
  "ml_historical_sales_backfill",
  "ml_initial_listings",
  "ml_initial_listings_current",
  "ml_initial_products",
]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number; batchDetails: number; salesPageLimit: number }} runtime
 */
async function dispatchJobChunk(supabase, job, runtime) {
  const t = String(job.job_type || "");
  console.info("[ML_ONBOARDING_SYNC_STEP_START]", {
    job_id: job.id ?? null,
    marketplace_account_id: job.marketplace_account_id ?? null,
    job_type: t,
    timestamp: new Date().toISOString(),
  });

  const done = () => {
    console.info("[ML_ONBOARDING_SYNC_STEP_DONE]", {
      job_id: job.id ?? null,
      marketplace_account_id: job.marketplace_account_id ?? null,
      job_type: t,
      timestamp: new Date().toISOString(),
    });
  };

  if (t === "ml_initial_sales_recent" || t === "ml_initial_sales_history" || t === "ml_historical_sales_backfill") {
    const out = await processMlSalesBatchJob(supabase, job, runtime);
    if (out?.done) done();
    return out;
  }
  if (t === "ml_initial_listings" || t === "ml_initial_listings_current") {
    const out = await runMlInitialListingsSyncJobTurn(supabase, job, { deadlineMs: runtime.deadlineMs });
    if (out?.done) done();
    const pir = Number(out?.listingsProcessedInRun ?? 0) || 0;
    return {
      stopped: out.stopped,
      done: out.done,
      processedInThisRun: pir,
    };
  }
  if (t === "ml_initial_products") {
    const out = await runMlInitialProductsSyncJobTurn(supabase, job, { deadlineMs: runtime.deadlineMs });
    if (out?.done) done();
    return out;
  }
  if (t === "ml_initial_fees") {
    await processFeesJob(supabase, job, runtime);
    done();
    return { stopped: true, done: true, processedInThisRun: 0 };
  }
  if (t === "ml_initial_customers" || t === "ml_initial_customers_recent") {
    await processCustomersJob(supabase, job);
    done();
    return { stopped: true, done: true, processedInThisRun: 0 };
  }
  if (t === "ml_historical_customers_backfill") {
    await completeStubJob(supabase, job, {
      skipped: true,
      step: "historical_customers_backfill",
      reason: "reserved_v1_enqueue_when_needed",
    });
    done();
    return { stopped: true, done: true, processedInThisRun: 0 };
  }
  if (t === "ml_sales_enrichment_backfill") {
    await completeStubJob(supabase, job, {
      skipped: true,
      step: "sales_enrichment_backfill",
      reason: "not_implemented_v1",
    });
    done();
    return { stopped: true, done: true, processedInThisRun: 0 };
  }
  if (t === "ml_enable_webhook_monitoring") {
    await processWebhookMonitoringJob(supabase, job);
    done();
    return { stopped: true, done: true, processedInThisRun: 0 };
  }

  await failMarketplaceSyncJob(
    supabase,
    String(job.id),
    `job_type_desconhecido:${t}`,
    "[ML_INITIAL_SYNC_JOB_ERROR]"
  );
  return { stopped: true, processedInThisRun: 0 };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number; batchDetails: number; salesPageLimit: number }} runtime
 */
async function dispatchJobChunkWithPerf(supabase, job, runtime) {
  const t0 = Date.now();
  const jobType = String(job.job_type || "");
  try {
    const out = await dispatchJobChunk(supabase, job, runtime);
    const status =
      out?.done === true ? "done" : out?.stopped === false ? "running" : out?.stopped === true ? "checkpoint" : "unknown";
    logS7Drain("marketplace-sync-job-performance", {
      jobId: job.id ?? null,
      jobType,
      marketplaceAccountId: job.marketplace_account_id ?? null,
      elapsedMs: Date.now() - t0,
      processedInThisRun: out?.processedInThisRun ?? null,
      progress_current: out?.progress_current ?? job.progress_current ?? null,
      progress_total: out?.progress_total ?? job.progress_total ?? null,
      status,
    });
    return { ok: true, out };
  } catch (e) {
    const msg = e?.message ? String(e.message).slice(0, 220) : String(e).slice(0, 220);
    logS7Drain("marketplace-sync-job-performance", {
      jobId: job.id ?? null,
      jobType,
      marketplaceAccountId: job.marketplace_account_id ?? null,
      elapsedMs: Date.now() - t0,
      processedInThisRun: null,
      progress_current: job.progress_current ?? null,
      progress_total: job.progress_total ?? null,
      status: "error",
      error_message: msg,
    });
    if (
      jobType === "ml_initial_sales_recent" ||
      jobType === "ml_initial_sales_history" ||
      jobType === "ml_historical_sales_backfill"
    ) {
      const tag = jobType === "ml_historical_sales_backfill" ? "[historical-sales-sync] window_error" : "[sales-sync] account_error";
      console.error(tag, {
        marketplace: ML_MARKETPLACE_SLUG,
        marketplace_account_id: job.marketplace_account_id ?? null,
        user_id: job.user_id ?? null,
        job_id: job.id ?? null,
        job_type: jobType,
        error_message: msg,
      });
      await failMarketplaceSyncJob(
        supabase,
        String(job.id),
        `runtime_exception:${msg}`,
        "[sales-sync] account_error"
      );
    }
    return { ok: false, error: e };
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ budgetMs?: number; batchDetails?: number; maxChunks?: number }} [opts]
 */
export async function runMarketplaceAccountSyncWorker(supabase, opts = {}) {
  resetMlDrainRequestMetrics();
  const drainStartedAt = Date.now();
  const budgetMs = resolveDrainTimeboxMs(opts);
  const salesPageLimit = resolveSalesSearchPageLimit();
  const batchDetails = resolveBatchDetails(opts, salesPageLimit);
  const maxJobsPerDrain = resolveMaxJobsPerDrain(opts);
  const fetchPoolLimit = resolveFetchJobsPoolLimit();
  const globalSyncConcurrency = resolveGlobalSyncConcurrency();
  const marketplaceMlConcurrency = resolveMarketplaceMlConcurrency();
  const perAcctJobConcurrencyRaw = parseInt(process.env.MARKETPLACE_SYNC_CONCURRENCY_PER_ACCOUNT || "1", 10);
  if (Number.isFinite(perAcctJobConcurrencyRaw) && perAcctJobConcurrencyRaw > 1) {
    console.warn("[S7][marketplace-sync-config-warn]", {
      env: "MARKETPLACE_SYNC_CONCURRENCY_PER_ACCOUNT",
      value: perAcctJobConcurrencyRaw,
      message:
        "Ainda há apenas 1 job inicial ML por conta por vez (evita estado conflitante). Valores > 1 ficam para fases futuras (jobs paralelos não conflitantes).",
    });
  }
  const absoluteDeadlineMs = drainStartedAt + budgetMs;
  const runtimePayload = { deadlineMs: absoluteDeadlineMs, batchDetails, salesPageLimit };

  /** @type {Record<string, unknown>[] } */
  const chunks = [];

  let jobsDispatchedTotal = 0;
  let jobsCompleted = 0;
  /** Contagem na última onda executada: jobs multi-turn que ainda não terminaram (timebox). */
  let jobsStillRunning = 0;
  /** @type {Set<string>} */
  const accountsProcessed = new Set();
  let ordersProcessed = 0;
  let listingsProcessed = 0;
  let errorCount = 0;

  console.info("[ML_ONBOARDING_SYNC_JOB_DISPATCHED]", {
    event: "worker_start",
    budget_ms: budgetMs,
    max_jobs_per_drain: maxJobsPerDrain,
    global_sync_concurrency: globalSyncConcurrency,
    marketplace_ml_concurrency: marketplaceMlConcurrency,
    batch_details: batchDetails,
    sales_page_limit: salesPageLimit,
    fetch_pool_limit: fetchPoolLimit,
    timestamp: new Date().toISOString(),
  });
  logS7Drain("marketplace-sync-drain-start", {
    jobId: null,
    jobType: null,
    marketplaceAccountId: null,
    sellerCompanyId: null,
    status: "running",
    progress_current: null,
    progress_total: null,
    cursor: null,
    elapsedMs: 0,
    budgetMs,
    maxJobsPerDrain,
    globalSyncConcurrency,
    marketplaceMlConcurrency,
    batchDetails,
    salesPageLimit,
    fetchPoolLimit,
  });
  console.info("[ML_ONBOARDING_SYNC_WORKER_ENTRY]", {
    max_jobs_per_drain: maxJobsPerDrain,
    fetch_pool_limit: fetchPoolLimit,
    global_sync_concurrency: globalSyncConcurrency,
    marketplace_ml_concurrency: marketplaceMlConcurrency,
    budget_ms: budgetMs,
    batch_details: batchDetails,
    sales_page_limit: salesPageLimit,
    build_fingerprint: {
      vercel_git_commit: process.env.VERCEL_GIT_COMMIT ?? null,
      vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    },
  });

  const staleMoved = await markStaleRunningJobsAsError(supabase);
  if (staleMoved > 0) {
    console.warn("[ML_INITIAL_SYNC_STALE_RUNNING_SWEEP_DONE]", {
      moved_to_error: staleMoved,
      stale_timeout_ms: RUNNING_STALE_TIMEOUT_MS,
    });
  }

  let waveIndex = 0;
  while (Date.now() < absoluteDeadlineMs && jobsDispatchedTotal < maxJobsPerDrain) {
    const iterStart = Date.now();
    const rows = await fetchJobsPool(supabase, fetchPoolLimit);
    const distinctMarketplaceAccountIds = [
      ...new Set(rows.map((r) => String(r.marketplace_account_id || "").trim()).filter(Boolean)),
    ];
    console.info("[worker] marketplace_accounts_batch_selected", {
      wave: waveIndex,
      job_rows: rows.length,
      distinct_marketplace_account_ids: distinctMarketplaceAccountIds.length,
      marketplace_account_ids_head: distinctMarketplaceAccountIds.slice(0, 80),
    });
    const countsByType = rows.reduce((acc, r) => {
      const jt = String(r.job_type || "unknown");
      const s = String(r.status || "unknown");
      if (!acc[jt]) acc[jt] = { pending: 0, running: 0, done: 0, error: 0, other: 0, total: 0 };
      if (s === "pending" || s === "running" || s === "done" || s === "error") acc[jt][s] += 1;
      else acc[jt].other += 1;
      acc[jt].total += 1;
      return acc;
    }, {});
    console.info("[ML_ONBOARDING_SYNC_WORKER_ENTRY]", {
      wave: waveIndex,
      pending_pool_total: rows.filter((r) => String(r.status || "") === "pending").length,
      running_pool_total: rows.filter((r) => String(r.status || "") === "running").length,
      counts_by_type: countsByType,
      marketplace_account_ids: [...new Set(rows.map((r) => String(r.marketplace_account_id || "")).filter(Boolean))].slice(
        0,
        20
      ),
    });
    const accountIds = [...new Set(rows.map((r) => String(r.marketplace_account_id || "")).filter(Boolean))];
    const statusMap = await loadLatestJobStatusMap(supabase, accountIds);
    const activeChunkByAccount = await fetchActiveMlJobCountsByAccount(supabase, accountIds);
    const webhookBacklogByAccount = await fetchPendingOrdersV2WebhookCountByAccount(supabase, accountIds);
    const sorted = sortEligibleJobs(rows, statusMap, webhookBacklogByAccount);

    const sortedIdSet = new Set(sorted.map((j) => String(j.id ?? "")));
    for (const j of rows) {
      if (sortedIdSet.has(String(j.id ?? ""))) continue;
      const aid = String(j.marketplace_account_id || "");
      const br = prerequisiteBlockReason(j, statusMap);
      console.info("[sales-sync] accounts_skipped", {
        wave: waveIndex,
        marketplace_account_id: aid || null,
        job_id: j.id ?? null,
        job_type: j.job_type ?? null,
        job_status: j.status ?? null,
        skip_reason: br,
        active_chunks_pending_running: aid ? activeChunkByAccount[aid] ?? 0 : 0,
      });
    }

    const jobTypes = sorted.map((j) => String(j.job_type || ""));
    console.log("[MARKETPLACE_SYNC_JOBS_FETCHED]", {
      wave: waveIndex,
      found: rows.length,
      eligible_count: sorted.length,
      max_jobs_per_drain: maxJobsPerDrain,
      budget_ms: budgetMs,
      job_types: jobTypes.slice(0, 48),
      job_types_truncated: jobTypes.length > 48,
      next_job_preview:
        sorted[0] != null
          ? {
              job_type: sorted[0].job_type ?? null,
              status: sorted[0].status ?? null,
              marketplace_account_id: sorted[0].marketplace_account_id ?? null,
            }
          : null,
    });

    const slotsLeft = maxJobsPerDrain - jobsDispatchedTotal;
    const wavePickLimit = resolveEffectiveWaveParallelism(slotsLeft);
    const picks = pickJobsDistinctAccounts(sorted, wavePickLimit);

    if (!picks.length) {
      logS7Drain("marketplace-sync-drain-no-jobs", {
        jobId: null,
        jobType: null,
        marketplaceAccountId: null,
        sellerCompanyId: null,
        status: "idle",
        progress_current: null,
        progress_total: null,
        cursor: null,
        elapsedMs: Date.now() - iterStart,
        wave: waveIndex,
      });
      console.info("[ML_ONBOARDING_SYNC_JOB_PICKED]", {
        picked: false,
        reason: "no_eligible_jobs",
        wave: waveIndex,
      });
      console.info("[sales-sync] accounts_selected", {
        wave: waveIndex,
        count: 0,
        pool_rows: rows.length,
        eligible_rows: sorted.length,
        accounts: [],
      });
      break;
    }

    console.info("[sales-sync] accounts_selected", {
      wave: waveIndex,
      count: picks.length,
      pool_rows: rows.length,
      eligible_rows: sorted.length,
      accounts: picks.map((p) => ({
        marketplace_account_id: String(p.marketplace_account_id || ""),
        job_id: p.id ?? null,
        job_type: p.job_type ?? null,
        job_status: p.status ?? null,
        active_chunks_pending_running: activeChunkByAccount[String(p.marketplace_account_id || "")] ?? 0,
      })),
    });

    for (const job of picks) {
      logS7Drain("marketplace-sync-drain-job-picked", {
        jobId: job.id ?? null,
        jobType: job.job_type ?? null,
        marketplaceAccountId: job.marketplace_account_id ?? null,
        sellerCompanyId: job.seller_company_id ?? null,
        status: job.status ?? null,
        progress_current: job.progress_current ?? null,
        progress_total: job.progress_total ?? null,
        cursor: job.last_cursor ?? null,
        elapsedMs: Date.now() - iterStart,
        wave: waveIndex,
      });
      console.info("[ML_ONBOARDING_SYNC_JOB_PICKED]", {
        picked: true,
        job_id: job.id ?? null,
        job_type: job.job_type ?? null,
        marketplace_account_id: job.marketplace_account_id ?? null,
        wave: waveIndex,
      });
    }

    const waveResults = await Promise.all(picks.map((job) => dispatchJobChunkWithPerf(supabase, job, runtimePayload)));

    console.info("[sales-sync] chunks_created", {
      wave: waveIndex,
      count: picks.length,
      marketplace_account_ids: picks.map((j) => String(j.marketplace_account_id || "")).filter(Boolean),
    });

    jobsDispatchedTotal += picks.length;

    let waveHungry = false;
    let waveHungryCount = 0;
    for (let i = 0; i < picks.length; i++) {
      const job = picks[i];
      const wr = waveResults[i];
      const aid = job.marketplace_account_id != null ? String(job.marketplace_account_id) : "";
      if (aid) accountsProcessed.add(aid);

      if (!wr.ok) {
        errorCount += 1;
        chunks.push({
          job_id: job.id,
          job_type: job.job_type,
          marketplace_account_id: job.marketplace_account_id,
          error: true,
          message: wr.error?.message ? String(wr.error.message) : String(wr.error),
        });
        logS7Drain("marketplace-sync-drain-job-finished", {
          jobId: job.id ?? null,
          jobType: job.job_type ?? null,
          marketplaceAccountId: job.marketplace_account_id ?? null,
          sellerCompanyId: job.seller_company_id ?? null,
          status: "error",
          progress_current: job.progress_current ?? null,
          progress_total: job.progress_total ?? null,
          cursor: job.last_cursor ?? null,
          elapsedMs: Date.now() - iterStart,
          wave: waveIndex,
        });
        continue;
      }

      const out = wr.out;
      const jt = String(job.job_type || "");
      if (
        jt === "ml_initial_sales_recent" ||
        jt === "ml_initial_sales_history" ||
        jt === "ml_historical_sales_backfill"
      ) {
        ordersProcessed += Number(out?.processedInThisRun ?? 0) || 0;
      }
      if (jt === "ml_initial_listings" || jt === "ml_initial_listings_current") {
        listingsProcessed += Number(out?.processedInThisRun ?? 0) || 0;
      }

      if (out?.done === true) jobsCompleted += 1;
      if (MULTI_TURN_RESUMABLE_JOB_TYPES.has(jt) && out?.stopped === false) {
        waveHungryCount += 1;
        waveHungry = true;
      }

      chunks.push({
        job_id: job.id,
        job_type: job.job_type,
        marketplace_account_id: job.marketplace_account_id,
        ...out,
      });

      logS7Drain("marketplace-sync-drain-job-finished", {
        jobId: job.id ?? null,
        jobType: job.job_type ?? null,
        marketplaceAccountId: job.marketplace_account_id ?? null,
        sellerCompanyId: job.seller_company_id ?? null,
        status: out?.done ? "done" : out?.stopped ? "stopped" : "running",
        progress_current: out?.progress_current ?? null,
        progress_total: out?.progress_total ?? null,
        cursor: out?.last_cursor ?? null,
        elapsedMs: Date.now() - iterStart,
        wave: waveIndex,
        processedInThisRun: out?.processedInThisRun ?? null,
      });
    }

    jobsStillRunning = waveHungryCount;
    waveIndex += 1;

    if (waveHungry) break;

    if (Date.now() >= absoluteDeadlineMs) break;
  }

  const mlMet = snapshotMlDrainRequestMetrics();
  logS7Drain("marketplace-sync-drain-summary", {
    startedAt: new Date(drainStartedAt).toISOString(),
    elapsedMs: Date.now() - drainStartedAt,
    jobsPicked: jobsDispatchedTotal,
    jobsCompleted,
    jobsStillRunning,
    accountsProcessed: accountsProcessed.size,
    ordersProcessed,
    listingsProcessed,
    rateLimitCount: mlMet.rateLimitCount,
    retryCount: mlMet.retryCount,
    timeoutCount: mlMet.timeoutCount,
    errorCount,
    budgetMs,
    maxJobsPerDrain,
    globalSyncConcurrency,
    marketplaceMlConcurrency,
  });

  const hasErrorChunk = chunks.some((c) => c?.error);
  if (hasErrorChunk) {
    logS7Drain("marketplace-sync-drain-error", {
      jobId: null,
      jobType: null,
      marketplaceAccountId: null,
      sellerCompanyId: null,
      status: "error",
      progress_current: null,
      progress_total: null,
      cursor: null,
      elapsedMs: Date.now() - drainStartedAt,
      chunks_processed: chunks.length,
      errorCount,
    });
    console.error("[ML_ONBOARDING_SYNC_FAILED]", {
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString(),
    });
  } else {
    console.info("[ML_ONBOARDING_SYNC_FINISHED]", {
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString(),
    });
  }

  /** Polling recente (não depende do seller logado) — budget dedicado após fila de jobs. */
  const incBudgetRaw = parseInt(process.env.ML_INCREMENTAL_SALES_BUDGET_MS || "14000", 10);
  const incBudget = Math.min(60000, Math.max(0, Number.isFinite(incBudgetRaw) ? incBudgetRaw : 14000));
  console.info("[sales-sync] incremental_poll_start", {
    budget_ms: incBudget,
    poll_enable_env: process.env.ML_INCREMENTAL_SALES_POLL_ENABLE ?? "(unset)",
    max_accounts_env: process.env.ML_INCREMENTAL_SALES_MAX_ACCOUNTS ?? "(unset)",
  });

  let incremental_sales_poll;
  if (incBudget <= 0) {
    incremental_sales_poll = {
      attempted: false,
      skipped: true,
      skip_reason: "incremental_budget_zero_or_invalid_ML_INCREMENTAL_SALES_BUDGET_MS",
      accounts_attempted: 0,
      orders_fetched: 0,
      orders_persisted: 0,
      errors: [],
    };
    console.info("[sales-sync] incremental_poll_skipped", {
      skip_reason: incremental_sales_poll.skip_reason,
      budget_ms: incBudget,
    });
  } else {
    try {
      incremental_sales_poll = await runIncrementalMlSalesPollWave(supabase, {
        deadlineMs: Date.now() + incBudget,
        maxAccounts: parseInt(process.env.ML_INCREMENTAL_SALES_MAX_ACCOUNTS || "12", 10) || 12,
      });
    } catch (e) {
      const em = e?.message ? String(e.message) : String(e);
      console.warn("[sales-sync] incremental_poll_wave_error", { message: em });
      incremental_sales_poll = {
        attempted: true,
        skipped: false,
        skip_reason: null,
        accounts_attempted: 0,
        orders_fetched: 0,
        orders_persisted: 0,
        errors: [em],
      };
    }
  }

  console.info("[sales-sync] incremental_poll_done", {
    attempted: incremental_sales_poll.attempted,
    skipped: incremental_sales_poll.skipped,
    skip_reason: incremental_sales_poll.skip_reason,
    accounts_attempted: incremental_sales_poll.accounts_attempted,
    orders_fetched: incremental_sales_poll.orders_fetched,
    orders_persisted: incremental_sales_poll.orders_persisted,
    error_count: incremental_sales_poll.errors?.length ?? 0,
  });

  return { ok: true, chunks_processed: chunks.length, chunks, incremental_sales_poll };
}
