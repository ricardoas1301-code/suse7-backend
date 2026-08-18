// ======================================================================
// Pré-requisitos do pipeline initial sync ML — masters first, sales last.
// DEV.V2.ML-INITIAL-SYNC-ORDER-HISTORY-WINDOW-CLOSE.01E-E
// ======================================================================

import {
  ML_SALES_HOT_TYPES,
  ML_LISTINGS_TYPES,
  ML_CUSTOMERS_TYPES,
} from "./createMlInitialSyncJobs.js";

/** Ordem de desempate no worker (menor = mais cedo). */
export const ML_PIPELINE_STEP_RANK = /** @type {const} */ ({
  ml_initial_listings_current: 1,
  ml_initial_listings: 1,
  ml_initial_fees: 2,
  ml_initial_products: 3,
  ml_initial_customers_recent: 4,
  ml_initial_customers: 4,
  ml_enable_webhook_monitoring: 5,
  ml_initial_sales_recent: 6,
  ml_initial_sales_history: 6,
  ml_historical_sales_backfill: 7,
  ml_historical_customers_backfill: 8,
  ml_sales_enrichment_backfill: 9,
});

/** Ordem alvo aprovada (01E-E). */
export const ML_TARGET_SYNC_JOB_ORDER = [
  "ml_initial_listings_current",
  "ml_initial_fees",
  "ml_initial_products",
  "ml_initial_customers_recent",
  "ml_enable_webhook_monitoring",
  "ml_initial_sales_recent",
];

/**
 * @param {Record<string, unknown>} job
 * @param {Record<string, string>} statusMap
 * @returns {string | null}
 */
export function resolveMlInitialSyncPrerequisiteBlockReason(job, statusMap) {
  const acc = String(job.marketplace_account_id || "");
  const needDone = (jt) => statusMap[`${acc}:${jt}`] === "done";
  const listingsDone = () => ML_LISTINGS_TYPES.some((jt) => needDone(jt));
  const customersHotDone = () => ML_CUSTOMERS_TYPES.some((jt) => needDone(jt));
  const salesHotDone = () => ML_SALES_HOT_TYPES.some((jt) => needDone(jt));
  const mastersAndWebhookDone = () =>
    listingsDone() &&
    needDone("ml_initial_fees") &&
    needDone("ml_initial_products") &&
    customersHotDone() &&
    needDone("ml_enable_webhook_monitoring");

  const t = String(job.job_type || "");

  if (t === "ml_initial_listings_current" || t === "ml_initial_listings") return null;

  if (t === "ml_initial_fees") {
    return listingsDone() ? null : "blocked_until_ml_listings_done";
  }
  if (t === "ml_initial_products") {
    if (!listingsDone()) return "blocked_until_ml_listings_done";
    if (!needDone("ml_initial_fees")) return "blocked_until_ml_initial_fees_done";
    return null;
  }
  if (t === "ml_initial_customers_recent" || t === "ml_initial_customers") {
    if (!listingsDone()) return "blocked_until_ml_listings_done";
    if (!needDone("ml_initial_fees")) return "blocked_until_ml_initial_fees_done";
    if (!needDone("ml_initial_products")) return "blocked_until_ml_initial_products_done";
    return null;
  }
  if (t === "ml_enable_webhook_monitoring") {
    if (!listingsDone()) return "blocked_until_ml_listings_done";
    if (!needDone("ml_initial_fees")) return "blocked_until_ml_initial_fees_done";
    if (!needDone("ml_initial_products")) return "blocked_until_ml_initial_products_done";
    if (!customersHotDone()) return "blocked_until_ml_customers_hot_done";
    return null;
  }
  if (t === "ml_initial_sales_recent" || t === "ml_initial_sales_history") {
    return mastersAndWebhookDone() ? null : "blocked_until_masters_and_webhook_done";
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

/** @param {string} jobType */
export function pipelineStepRank(jobType) {
  return ML_PIPELINE_STEP_RANK[/** @type {keyof typeof ML_PIPELINE_STEP_RANK} */ (jobType)] ?? 50;
}
