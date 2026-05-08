// ======================================================================
// Worker assíncrono: marketplace_account_sync_jobs (Mercado Livre inicial).
// Invocado pelo cron POST /api/jobs/marketplace-account-sync (X-Job-Secret).
// ======================================================================

import {
  fetchMercadoLibreUserMe,
  fetchOrderById,
  nextOrdersSearchOffset,
  searchSellerOrdersPage,
} from "../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { applyMlOrderDetailToMarketplaceSales } from "../../modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { ingestCustomersFromSales } from "../customers/customerIngestionService.js";
import { ML_INITIAL_SYNC_JOB_TYPES_ORDERED } from "./createMlInitialSyncJobs.js";
import {
  ensureMarketplaceSyncJobRunning,
  patchMarketplaceSyncJob,
  completeMarketplaceSyncJob,
  failMarketplaceSyncJob,
} from "./marketplaceSyncJobHelpers.js";
import { runMlInitialListingsSyncJobTurn } from "../../handlers/ml/_helpers/mlInitialOnboardingListingsSync.js";
import { runMlInitialProductsSyncJobTurn } from "../../handlers/ml/_helpers/mlInitialOnboardingProductsSync.js";
import { runMlInitialFeesSyncTurn } from "./mlFeesSyncService.js";

const PAGE_LIMIT = 50;
const ML_INITIAL_ORDERS_LOOKBACK_DAYS = Math.min(
  3650,
  Math.max(1, parseInt(process.env.ML_INITIAL_ORDERS_LOOKBACK_DAYS || "90", 10) || 90)
);

const JOB_PRIORITY = Object.fromEntries(ML_INITIAL_SYNC_JOB_TYPES_ORDERED.map((t, i) => [t, i + 1]));
const ORDER_FETCH_TIMEOUT_MS = Math.min(
  120000,
  Math.max(5000, parseInt(process.env.ML_INITIAL_SALES_ORDER_FETCH_TIMEOUT_MS || "25000", 10) || 25000)
);
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

/** @param {string} jobType */
function jobRank(jobType) {
  return JOB_PRIORITY[jobType] ?? 99;
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
 * @param {string} accountId
 * @param {string | null} detailMaxCreated
 * @param {string} nowIso
 */
async function advanceMlSalesWatermark(supabase, accountId, detailMaxCreated, nowIso) {
  const { data: row, error } = await supabase
    .from("marketplace_accounts")
    .select("ml_sales_last_synced_order_created_to")
    .eq("id", accountId)
    .maybeSingle();

  if (error) throw error;

  const prev =
    row?.ml_sales_last_synced_order_created_to != null
      ? String(row.ml_sales_last_synced_order_created_to)
      : null;
  let next = prev;
  const c = detailMaxCreated ? String(detailMaxCreated) : null;
  if (c && (!prev || Date.parse(c) > Date.parse(prev))) next = c;

  const { error: uErr } = await supabase
    .from("marketplace_accounts")
    .update({
      ml_sales_last_sync_at: nowIso,
      ml_sales_last_synced_order_created_to: next,
      updated_at: nowIso,
    })
    .eq("id", accountId);

  if (uErr) throw uErr;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {number} limit
 */
async function fetchJobsPool(supabase, limit = 160) {
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
    .in("job_type", ML_INITIAL_SYNC_JOB_TYPES_ORDERED)
    .order("created_at", { ascending: false })
    .limit(600);

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
function prerequisiteAllows(job, statusMap) {
  const acc = String(job.marketplace_account_id || "");
  const need = (jt) => statusMap[`${acc}:${jt}`] === "done";

  const t = String(job.job_type || "");
  if (t === "ml_initial_sales_history") return true;
  if (t === "ml_initial_listings") return need("ml_initial_sales_history");
  if (t === "ml_initial_fees") {
    return need("ml_initial_sales_history") && need("ml_initial_listings");
  }
  if (t === "ml_initial_products") {
    return need("ml_initial_sales_history") && need("ml_initial_listings") && need("ml_initial_fees");
  }
  if (t === "ml_initial_customers") {
    return (
      need("ml_initial_sales_history") &&
      need("ml_initial_listings") &&
      need("ml_initial_fees") &&
      need("ml_initial_products")
    );
  }
  if (t === "ml_enable_webhook_monitoring") {
    return (
      need("ml_initial_sales_history") &&
      need("ml_initial_listings") &&
      need("ml_initial_fees") &&
      need("ml_initial_products") &&
      need("ml_initial_customers")
    );
  }
  return false;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, string>} statusMap
 */
function sortEligibleJobs(rows, statusMap) {
  const filtered = rows.filter((j) => prerequisiteAllows(j, statusMap));
  filtered.sort((a, b) => {
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
    const pa = jobRank(String(a.job_type || ""));
    const pb = jobRank(String(b.job_type || ""));
    if (pa !== pb) return pa - pb;
    return ua - ub;
  });
  return filtered;
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
 * @param {{ deadlineMs: number; batchDetails: number }} opts
 */
async function processMlInitialSalesHistoryBatch(supabase, job, opts) {
  const { deadlineMs, batchDetails } = opts;

  const accountId = String(job.marketplace_account_id || "");
  const userId = String(job.user_id || "");
  let jRow = await ensureMarketplaceSyncJobRunning(supabase, job);

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
    return { stopped: true };
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
    return { stopped: true };
  }

  let sellerId =
    accountRow.external_seller_id != null ? String(accountRow.external_seller_id).trim() : "";
  try {
    const me = await fetchMercadoLibreUserMe(accessToken);
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
    return { stopped: true };
  }

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

  const sellerCompanyFromAcc =
    accountRow.seller_company_id != null ? String(accountRow.seller_company_id) : null;
  const rangeTo = new Date().toISOString();
  const rangeFrom = new Date(Date.now() - ML_INITIAL_ORDERS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.info("[ML_ORDERS_FETCH_RANGE]", {
    job_id: jRow.id,
    marketplace_account_id: accountId,
    date_from: rangeFrom,
    date_to: rangeTo,
    lookback_days: ML_INITIAL_ORDERS_LOOKBACK_DAYS,
  });

  let processedTotal = Number(jRow.progress_current ?? 0) || 0;
  let progressTotal = jRow.progress_total != null ? Number(jRow.progress_total) : null;

  /** @type {{ synced_count: number; created_count: number; updated_count: number; skipped_count: number; errors: string[] }} */
  const summaryStub = {
    synced_count: 0,
    created_count: 0,
    updated_count: 0,
    skipped_count: 0,
    errors: [],
  };
  let partialErrors = 0;
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

  while (Date.now() < deadlineMs) {
    console.info("[ML_ORDERS_FETCH_START]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      seller_id: sellerId,
      offset: cursor.search_offset,
    });
    const page = await searchSellerOrdersPage(accessToken, sellerId, cursor.search_offset, PAGE_LIMIT, {
      dateFrom: rangeFrom,
      dateTo: rangeTo,
    });

    if (progressTotal == null && page.paging?.total != null) {
      progressTotal = Number(page.paging.total);
    }

    const orderIds = page.orderIds || [];
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

    if (orderIds.length === 0) {
      const partialSummaryMsg =
        partialErrors > 0 ? `completed_with_partial_errors:${partialErrors}` : null;
      await completeMarketplaceSyncJob(supabase, String(jRow.id), {
        progress_total: progressTotal ?? processedTotal,
        progress_current: processedTotal,
        last_cursor: null,
        last_synced_at: new Date().toISOString(),
        error_message: partialSummaryMsg,
        metadata: {
          ...(typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
            ? /** @type {Record<string, unknown>} */ (jRow.metadata)
            : {}),
          phase: "sales",
          errors_count: partialErrors,
          errors_sample: summaryStub.errors.slice(-20),
        },
      });
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
      return { stopped: true, done: true };
    }

    if (cursor.idx_in_page >= orderIds.length) {
      cursor.search_offset = nextOrdersSearchOffset(cursor.search_offset, PAGE_LIMIT, orderIds.length);
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

    for (const oid of slice) {
      const orderIndex = processedTotal + 1;
      console.info("[S7][ml-sales-sync-order-step]", {
        syncRunId: jRow.id,
        marketplaceAccountId: accountId,
        sellerCompanyId: sellerCompanyFromAcc,
        externalOrderId: String(oid),
        index: orderIndex,
        total: progressTotal,
        step: "fetch order",
      });
      let detail;
      try {
        detail = await withTimeout(fetchOrderById(accessToken, oid), ORDER_FETCH_TIMEOUT_MS, "fetch_order");
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
        cursor.idx_in_page += 1;
        processedTotal += 1;
        const metaBase =
          typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
            ? /** @type {Record<string, unknown>} */ (jRow.metadata)
            : {};
        await safePatchProgress({
          progress_total: progressTotal,
          progress_current: processedTotal,
          last_cursor: serializeSalesCursor(cursor),
          last_synced_at: new Date().toISOString(),
          metadata: {
            ...metaBase,
            phase: "sales",
            errors_count: partialErrors,
            last_error_order_id: String(oid),
            last_error_message: msg.slice(0, 220),
            errors_sample: summaryStub.errors.slice(-20),
          },
        }, "after_fetch_error");
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
            }
          ),
          ORDER_PROCESS_TIMEOUT_MS,
          "process_order"
        );
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
      const perOrderMetaBase =
        typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
          ? /** @type {Record<string, unknown>} */ (jRow.metadata)
          : {};
      await safePatchProgress({
        progress_total: progressTotal,
        progress_current: processedTotal,
        last_cursor: serializeSalesCursor(cursor),
        last_synced_at: new Date().toISOString(),
        metadata: {
          ...perOrderMetaBase,
          phase: "sales",
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
      });
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
      await advanceMlSalesWatermark(supabase, accountId, batchMaxCreated, nowIso);
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
        phase: "sales",
        errors_count: partialErrors,
        last_batch_orders: slice.length,
        errors_sample: summaryStub.errors.slice(-12),
      },
    }, "after_batch");
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

  return { stopped: false };
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

  console.info("[ML_INITIAL_CUSTOMERS_START]", { job_id: j.id, marketplace_account_id: accountId });

  try {
    const ingestion = await ingestCustomersFromSales({
      supabase,
      userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplaceAccountId: accountId,
      sellerCompanyId,
      saleDateFrom: null,
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

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number; batchDetails: number }} runtime
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

  if (t === "ml_initial_sales_history") {
    const out = await processMlInitialSalesHistoryBatch(supabase, job, runtime);
    if (out?.done) done();
    return out;
  }
  if (t === "ml_initial_listings") {
    const out = await runMlInitialListingsSyncJobTurn(supabase, job, { deadlineMs: runtime.deadlineMs });
    if (out?.done) done();
    return out;
  }
  if (t === "ml_initial_products") {
    const out = await runMlInitialProductsSyncJobTurn(supabase, job, { deadlineMs: runtime.deadlineMs });
    if (out?.done) done();
    return out;
  }
  if (t === "ml_initial_fees") {
    await processFeesJob(supabase, job, runtime);
    done();
    return { stopped: true, done: true };
  }
  if (t === "ml_initial_customers") {
    await processCustomersJob(supabase, job);
    done();
    return { stopped: true, done: true };
  }
  if (t === "ml_enable_webhook_monitoring") {
    await processWebhookMonitoringJob(supabase, job);
    done();
    return { stopped: true, done: true };
  }

  await failMarketplaceSyncJob(
    supabase,
    String(job.id),
    `job_type_desconhecido:${t}`,
    "[ML_INITIAL_SYNC_JOB_ERROR]"
  );
  return { stopped: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ budgetMs?: number; batchDetails?: number; maxChunks?: number }} [opts]
 */
export async function runMarketplaceAccountSyncWorker(supabase, opts = {}) {
  const budgetMs = Math.min(
    120000,
    Math.max(
      3000,
      parseInt(String(opts.budgetMs ?? process.env.ML_MARKETPLACE_SYNC_BUDGET_MS ?? "55000"), 10) || 55000
    )
  );
  const batchDetails = Math.min(
    80,
    Math.max(
      4,
      parseInt(String(opts.batchDetails ?? process.env.ML_INITIAL_SALES_BATCH_DETAILS ?? "14"), 10) || 14
    )
  );
  const maxChunks = Math.min(
    50,
    Math.max(
      1,
      parseInt(String(opts.maxChunks ?? process.env.ML_MARKETPLACE_SYNC_JOB_MAX_CHUNKS ?? "8"), 10) || 8
    )
  );

  /** @type {Record<string, unknown>[] } */
  const chunks = [];

  console.info("[ML_ONBOARDING_SYNC_JOB_DISPATCHED]", {
    event: "worker_start",
    budget_ms: budgetMs,
    max_chunks: maxChunks,
    batch_details: batchDetails,
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
    maxChunks,
    batchDetails,
  });
  console.info("[ML_ONBOARDING_SYNC_WORKER_ENTRY]", {
    limit: maxChunks,
    budget_ms: budgetMs,
    batch_details: batchDetails,
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

  for (let i = 0; i < maxChunks; i++) {
    const iterStart = Date.now();
    const rows = await fetchJobsPool(supabase, 160);
    const countsByType = rows.reduce((acc, r) => {
      const t = String(r.job_type || "unknown");
      const s = String(r.status || "unknown");
      if (!acc[t]) acc[t] = { pending: 0, running: 0, done: 0, error: 0, other: 0, total: 0 };
      if (s === "pending" || s === "running" || s === "done" || s === "error") acc[t][s] += 1;
      else acc[t].other += 1;
      acc[t].total += 1;
      return acc;
    }, {});
    console.info("[ML_ONBOARDING_SYNC_WORKER_ENTRY]", {
      iteration: i,
      pending_pool_total: rows.filter((r) => String(r.status || "") === "pending").length,
      running_pool_total: rows.filter((r) => String(r.status || "") === "running").length,
      counts_by_type: countsByType,
      marketplace_account_ids: [...new Set(rows.map((r) => String(r.marketplace_account_id || "")).filter(Boolean))].slice(0, 20),
    });
    const accountIds = [
      ...new Set(rows.map((r) => String(r.marketplace_account_id || "")).filter(Boolean)),
    ];
    const statusMap = await loadLatestJobStatusMap(supabase, accountIds);
    const sorted = sortEligibleJobs(rows, statusMap);

    /** Tipos elegíveis neste ciclo (pipeline: sales → listings → products → …). */
    const jobTypes = sorted.map((j) => String(j.job_type || ""));
    console.log("[MARKETPLACE_SYNC_JOBS_FETCHED]", {
      iteration: i,
      found: rows.length,
      eligible_count: sorted.length,
      maxChunks,
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

    const job = sorted[0];
    if (!job) {
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
        iteration: i,
      });
      console.info("[ML_ONBOARDING_SYNC_JOB_PICKED]", {
        picked: false,
        reason: "no_eligible_jobs",
        iteration: i,
      });
      break;
    }
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
      iteration: i,
    });
    console.info("[ML_ONBOARDING_SYNC_JOB_PICKED]", {
      picked: true,
      job_id: job.id ?? null,
      job_type: job.job_type ?? null,
      marketplace_account_id: job.marketplace_account_id ?? null,
      iteration: i,
    });

    const deadlineMs = Date.now() + budgetMs;
    const out = await dispatchJobChunk(supabase, job, { deadlineMs, batchDetails });
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
      iteration: i,
    });

    chunks.push({
      job_id: job.id,
      job_type: job.job_type,
      marketplace_account_id: job.marketplace_account_id,
      ...out,
    });

    const multiTurnTypes = new Set([
      "ml_initial_sales_history",
      "ml_initial_listings",
      "ml_initial_fees",
      "ml_initial_products",
    ]);
    if (!out?.stopped && multiTurnTypes.has(String(job.job_type || ""))) {
      break;
    }
  }

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
      elapsedMs: 0,
      chunks_processed: chunks.length,
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

  return { ok: true, chunks_processed: chunks.length, chunks };
}
