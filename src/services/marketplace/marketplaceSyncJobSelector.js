// ======================================================================
// Selector global marketplace sync — sort/pick compartilhado (worker + dry-run).
// P0.2-M.2 — ordem canônica window_index para ml_historical_sales_backfill.
// ======================================================================

import { resolveMlInitialSyncPrerequisiteBlockReason, pipelineStepRank } from "./mlInitialSyncPrerequisites.js";
import {
  isJobLeaseExpired,
  readJobLeaseMeta,
  readJobMetadataObject,
  resolveStaleRecoveryThresholdMs,
} from "./marketplaceSyncJobLease.js";

export const ML_HISTORICAL_SALES_BACKFILL_JOB_TYPE = "ml_historical_sales_backfill";

/** @param {Record<string, unknown>} job */
export function readHistoricalWindowIndex(job) {
  if (String(job.job_type || "") !== ML_HISTORICAL_SALES_BACKFILL_JOB_TYPE) return null;
  const meta = readJobMetadataObject(job);
  const n = Number(meta.window_index);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** @param {Record<string, unknown>} job */
function jobEffectivePriority(job) {
  const meta = readJobMetadataObject(job);
  const raw = job.priority ?? meta.priority;
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(n)) return n;
  return 0;
}

/** @param {Record<string, unknown>} job @param {Record<string, string>} statusMap */
export function resolvePrerequisiteBlockReason(job, statusMap) {
  return resolveMlInitialSyncPrerequisiteBlockReason(job, statusMap);
}

/**
 * Desempate canônico entre janelas históricas da mesma conta.
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
export function compareHistoricalWindowIndex(a, b) {
  const accountA = a.marketplace_account_id != null ? String(a.marketplace_account_id).trim() : "";
  const accountB = b.marketplace_account_id != null ? String(b.marketplace_account_id).trim() : "";
  if (!accountA || accountA !== accountB) return 0;
  const wa = readHistoricalWindowIndex(a);
  const wb = readHistoricalWindowIndex(b);
  if (wa == null || wb == null) return 0;
  return wa - wb;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, string>} statusMap
 * @param {Record<string, number>} [webhookBacklogByAccount]
 * @param {number} [nowMs]
 */
export function sortEligibleJobs(rows, statusMap, webhookBacklogByAccount = {}, nowMs = Date.now()) {
  const staleHalfThreshold = resolveStaleRecoveryThresholdMs() / 2;
  const webhookPenaltyFor = (job) => {
    const aid = job.marketplace_account_id != null ? String(job.marketplace_account_id).trim() : "";
    const backlog = aid ? webhookBacklogByAccount[aid] || 0 : 0;
    if (backlog <= 0) return 0;
    const jobType = String(job.job_type || "");
    if (jobType === ML_HISTORICAL_SALES_BACKFILL_JOB_TYPE || jobType === "ml_initial_sales_history") return 1000;
    if (jobType === "ml_initial_listings" || jobType === "ml_initial_listings_current") return 100;
    if (jobType === "ml_initial_fees" || jobType === "ml_initial_products") return 50;
    return 0;
  };

  const filtered = rows.filter((j) => resolvePrerequisiteBlockReason(j, statusMap) == null);
  filtered.sort((a, b) => {
    const penaltyA = webhookPenaltyFor(a);
    const penaltyB = webhookPenaltyFor(b);
    if (penaltyA !== penaltyB) return penaltyA - penaltyB;
    const sa = String(a.status || "").toLowerCase();
    const sb = String(b.status || "").toLowerCase();
    const leaseA = readJobLeaseMeta(a);
    const leaseB = readJobLeaseMeta(b);
    const hbA = leaseA.heartbeat_at || a.updated_at || a.created_at;
    const hbB = leaseB.heartbeat_at || b.updated_at || b.created_at;
    const ua = new Date(/** @type {string} */ (hbA || 0)).getTime();
    const ub = new Date(/** @type {string} */ (hbB || 0)).getTime();
    const staleA =
      sa === "running" &&
      (isJobLeaseExpired(a, nowMs) || (Number.isFinite(ua) && nowMs - ua > staleHalfThreshold));
    const staleB =
      sb === "running" &&
      (isJobLeaseExpired(b, nowMs) || (Number.isFinite(ub) && nowMs - ub > staleHalfThreshold));
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
    const histCmp = compareHistoricalWindowIndex(a, b);
    if (histCmp !== 0) return histCmp;
    return ua - ub;
  });
  return filtered;
}

/**
 * Até um job por conta por onda.
 * @param {Record<string, unknown>[]} sortedEligible
 * @param {number} maxPick
 */
export function pickJobsDistinctAccounts(sortedEligible, maxPick) {
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
 * Seleciona jobs após projeção de recovery (helper compartilhado worker/dry-run).
 * @param {Record<string, unknown>[]} poolRows
 * @param {Record<string, string>} statusMap
 * @param {Record<string, number>} webhookBacklogByAccount
 * @param {number} maxPick
 * @param {number} [nowMs]
 */
export function selectJobsFromProjectedPool(poolRows, statusMap, webhookBacklogByAccount, maxPick, nowMs = Date.now()) {
  const sorted = sortEligibleJobs(poolRows, statusMap, webhookBacklogByAccount, nowMs);
  return pickJobsDistinctAccounts(sorted, maxPick);
}
