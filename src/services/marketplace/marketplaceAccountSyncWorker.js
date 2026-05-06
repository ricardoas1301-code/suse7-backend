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

const JOB_PRIORITY = Object.fromEntries(ML_INITIAL_SYNC_JOB_TYPES_ORDERED.map((t, i) => [t, i + 1]));

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
    const pa = jobRank(String(a.job_type || ""));
    const pb = jobRank(String(b.job_type || ""));
    if (pa !== pb) return pa - pb;
    const ua = new Date(/** @type {string} */ (a.updated_at || a.created_at || 0)).getTime();
    const ub = new Date(/** @type {string} */ (b.updated_at || b.created_at || 0)).getTime();
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

  const sellerCompanyFromAcc =
    accountRow.seller_company_id != null ? String(accountRow.seller_company_id) : null;

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

  while (Date.now() < deadlineMs) {
    const page = await searchSellerOrdersPage(accessToken, sellerId, cursor.search_offset, PAGE_LIMIT, {});

    if (progressTotal == null && page.paging?.total != null) {
      progressTotal = Number(page.paging.total);
    }

    const orderIds = page.orderIds || [];

    console.info("[ML_INITIAL_SALES_SYNC_BATCH]", {
      job_id: jRow.id,
      search_offset: cursor.search_offset,
      idx_in_page: cursor.idx_in_page,
      page_orders: orderIds.length,
      paging_total: page.paging?.total ?? null,
      processed_so_far: processedTotal,
    });

    if (orderIds.length === 0) {
      await completeMarketplaceSyncJob(supabase, String(jRow.id), {
        progress_total: progressTotal ?? processedTotal,
        progress_current: processedTotal,
        last_cursor: null,
        last_synced_at: new Date().toISOString(),
      });
      console.info("[ML_INITIAL_SALES_SYNC_DONE]", {
        job_id: jRow.id,
        marketplace_account_id: accountId,
        processedTotal,
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
      let detail;
      try {
        detail = await fetchOrderById(accessToken, oid);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        console.error("[ML_INITIAL_SALES_SYNC_ERROR]", { job_id: jRow.id, order_id: oid, msg });
        summaryStub.errors.push(`${oid}: ${msg}`);
        cursor.idx_in_page += 1;
        processedTotal += 1;
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
        await applyMlOrderDetailToMarketplaceSales(
          supabase,
          userId,
          accountId,
          sellerCompanyFromAcc,
          detail,
          nowIso,
          summaryStub,
          accessToken
        );
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        console.error("[ML_INITIAL_SALES_SYNC_ERROR]", { job_id: jRow.id, order_id: oid, msg });
        summaryStub.errors.push(`${oid}: ${msg}`);
      }

      cursor.idx_in_page += 1;
      processedTotal += 1;
    }

    if (batchMaxCreated) {
      await advanceMlSalesWatermark(supabase, accountId, batchMaxCreated, nowIso);
    }

    const metaBase =
      typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
        ? /** @type {Record<string, unknown>} */ (jRow.metadata)
        : {};

    await patchMarketplaceSyncJob(supabase, String(jRow.id), {
      last_cursor: serializeSalesCursor(cursor),
      progress_total: progressTotal,
      progress_current: processedTotal,
      last_synced_at: nowIso,
      metadata: {
        ...metaBase,
        last_batch_orders: slice.length,
        errors_sample: summaryStub.errors.slice(-12),
      },
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
  console.info("[ML_INITIAL_WEBHOOK_MONITORING]", {
    job_id: j.id,
    marketplace_account_id: j.marketplace_account_id,
  });
  await completeStubJob(supabase, j, {
    monitoring: "webhook_pipeline_ready",
    ingest_path: "/api/ml/webhook",
    processor_job: "/api/jobs/ml-webhook-events",
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number; batchDetails: number }} runtime
 */
async function dispatchJobChunk(supabase, job, runtime) {
  const t = String(job.job_type || "");
  if (t === "ml_initial_sales_history") {
    return processMlInitialSalesHistoryBatch(supabase, job, runtime);
  }
  if (t === "ml_initial_listings") {
    return runMlInitialListingsSyncJobTurn(supabase, job, { deadlineMs: runtime.deadlineMs });
  }
  if (t === "ml_initial_products") {
    return runMlInitialProductsSyncJobTurn(supabase, job, { deadlineMs: runtime.deadlineMs });
  }
  if (t === "ml_initial_fees") {
    await processFeesJob(supabase, job, runtime);
    return { stopped: true, done: true };
  }
  if (t === "ml_initial_customers") {
    await processCustomersJob(supabase, job);
    return { stopped: true, done: true };
  }
  if (t === "ml_enable_webhook_monitoring") {
    await processWebhookMonitoringJob(supabase, job);
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

  for (let i = 0; i < maxChunks; i++) {
    const rows = await fetchJobsPool(supabase, 160);
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
    if (!job) break;

    const deadlineMs = Date.now() + budgetMs;
    const out = await dispatchJobChunk(supabase, job, { deadlineMs, batchDetails });

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

  return { ok: true, chunks_processed: chunks.length, chunks };
}
