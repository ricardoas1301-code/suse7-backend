// ======================================================================
// Pós-conclusão unificada — jobs hot de vendas ML (normal batch + resume-complete).
// ======================================================================

import {
  enqueueHistoricalSalesBackfillJobs,
} from "./createMlInitialSyncJobs.js";

/**
 * @param {string} jobType
 * @param {Record<string, unknown>} [metadata]
 */
export function shouldEnqueueHistoricalAfterHotSalesComplete(jobType, metadata = {}) {
  const t = String(jobType || "");
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  if (t === "ml_historical_sales_backfill") return false;
  if (t === "ml_initial_sales_recent") return true;
  if (t === "ml_initial_sales_history" && meta.import_full_history !== true) return true;
  return false;
}

/**
 * Indica se deve tentar finalização de histórico vazio (hot sem vendas importadas).
 * @param {{ metadata?: Record<string, unknown>; progressCurrent?: number | null }} ctx
 */
export function shouldTryEmptyHistoricalFinalizeAfterHot(ctx) {
  const meta = ctx.metadata && typeof ctx.metadata === "object" ? ctx.metadata : {};
  const saved = Number(meta.ml_sales_import_saved) || 0;
  const apiTotal = Number(meta.ml_sales_import_api_total) || 0;
  const progress = Number(ctx.progressCurrent);
  if (Number.isFinite(progress) && progress > 0) return false;
  return saved <= 0 && apiTotal <= 0;
}

/**
 * Hook único de pós-conclusão para jobs hot de vendas.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   jobId: string;
 *   jobType: string;
 *   userId: string;
 *   marketplaceAccountId: string;
 *   sellerCompanyId?: string | null;
 *   marketplace?: string;
 *   metadata?: Record<string, unknown>;
 *   progressCurrent?: number | null;
 *   completionPath: "normal_batch" | "resume_complete" | "done_job_replay";
 *   finalizeEmptyHistorical?: (args: {
 *     accountId: string;
 *     sellerId: string;
 *     accessToken: string;
 *     reason: string;
 *   }) => Promise<{ finalized?: number }>;
 *   sellerId?: string | null;
 *   accessToken?: string | null;
 * }} ctx
 */
export async function runMlSalesHotJobPostCompletion(supabase, ctx) {
  const jobType = String(ctx.jobType || "");
  const metadata = ctx.metadata && typeof ctx.metadata === "object" ? ctx.metadata : {};

  if (!shouldEnqueueHistoricalAfterHotSalesComplete(jobType, metadata)) {
    return {
      ran: false,
      reason: "not_applicable_for_job_type",
      job_type: jobType,
      completion_path: ctx.completionPath,
    };
  }

  console.info("[S7][ml-sales-hot-post-completion-start]", {
    job_id: ctx.jobId,
    marketplace_account_id: ctx.marketplaceAccountId,
    job_type: jobType,
    completion_path: ctx.completionPath,
  });

  /** @type {{ created: number; skipped: boolean; error?: string }} */
  let enqueueResult = { created: 0, skipped: true };

  try {
    const raw = await enqueueHistoricalSalesBackfillJobs(supabase, {
      userId: String(ctx.userId || ""),
      marketplaceAccountId: String(ctx.marketplaceAccountId || ""),
      sellerCompanyId: ctx.sellerCompanyId ?? null,
      marketplace: ctx.marketplace ?? "mercado_livre",
    });
    enqueueResult = {
      created: Number(raw?.created ?? 0) || 0,
      skipped: Boolean(raw?.skipped),
    };
  } catch (e) {
    const message = e?.message ?? String(e);
    console.warn("[ML_HISTORICAL_SALES_BACKFILL_ENQUEUE_WARN]", {
      job_id: ctx.jobId,
      marketplace_account_id: ctx.marketplaceAccountId,
      completion_path: ctx.completionPath,
      message,
    });
    return {
      ran: true,
      completion_path: ctx.completionPath,
      enqueue: { created: 0, skipped: false, error: message },
      retriable: true,
    };
  }

  console.info("[S7][ml-sales-hot-post-completion-enqueue]", {
    job_id: ctx.jobId,
    marketplace_account_id: ctx.marketplaceAccountId,
    completion_path: ctx.completionPath,
    created: enqueueResult.created,
    skipped: enqueueResult.skipped,
  });

  let emptyFinalize = { attempted: false, finalized: 0 };

  if (
    shouldTryEmptyHistoricalFinalizeAfterHot({
      metadata,
      progressCurrent: ctx.progressCurrent,
    }) &&
    typeof ctx.finalizeEmptyHistorical === "function" &&
    ctx.sellerId &&
    ctx.accessToken
  ) {
    emptyFinalize.attempted = true;
    try {
      const fin = await ctx.finalizeEmptyHistorical({
        accountId: String(ctx.marketplaceAccountId),
        sellerId: String(ctx.sellerId),
        accessToken: String(ctx.accessToken),
        reason: `post_completion_${ctx.completionPath}`,
      });
      emptyFinalize.finalized = Number(fin?.finalized ?? 0) || 0;
    } catch (e) {
      console.warn("[ML_HISTORICAL_EMPTY_BACKFILL_FINALIZE_WARN]", {
        marketplace_account_id: ctx.marketplaceAccountId,
        completion_path: ctx.completionPath,
        message: e?.message ?? String(e),
      });
    }
  }

  return {
    ran: true,
    completion_path: ctx.completionPath,
    enqueue: enqueueResult,
    empty_finalize: emptyFinalize,
    retriable: false,
  };
}

/**
 * Reexecuta pós-conclusão para job hot já `done` (retomável, idempotente).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} jobRow
 * @param {Omit<Parameters<typeof runMlSalesHotJobPostCompletion>[1], "jobId"|"jobType"|"userId"|"marketplaceAccountId"|"metadata"|"progressCurrent"|"completionPath">} [extras]
 */
export async function runMlSalesHotJobPostCompletionForDoneJob(supabase, jobRow, extras = {}) {
  const status = String(jobRow?.status || "").toLowerCase();
  if (status !== "done") {
    return { ok: false, reason: "job_not_done", status };
  }
  const meta =
    jobRow.metadata && typeof jobRow.metadata === "object" && !Array.isArray(jobRow.metadata)
      ? /** @type {Record<string, unknown>} */ (jobRow.metadata)
      : {};
  return runMlSalesHotJobPostCompletion(supabase, {
    jobId: String(jobRow.id),
    jobType: String(jobRow.job_type || ""),
    userId: String(jobRow.user_id || ""),
    marketplaceAccountId: String(jobRow.marketplace_account_id || ""),
    sellerCompanyId: jobRow.seller_company_id ?? null,
    marketplace: jobRow.marketplace != null ? String(jobRow.marketplace) : "mercado_livre",
    metadata: meta,
    progressCurrent: jobRow.progress_current != null ? Number(jobRow.progress_current) : null,
    completionPath: "done_job_replay",
    ...extras,
  });
}
