// ======================================================================
// Helpers compartilhados para marketplace_account_sync_jobs (worker + onboarding ML).
// ======================================================================

import {
  tryClaimMarketplaceSyncJob,
  touchMarketplaceSyncJobHeartbeat,
  readJobMetadataObject,
  buildLeaseHeartbeatMetadataPatch,
  mergeOperationalSyncJobMetadata,
  resolveSyncExecutorId,
} from "./marketplaceSyncJobLease.js";

/**
 * Job de sync já atingiu progress_total — finalizar sem reprocessar carga.
 * @param {Record<string, unknown> | null | undefined} jobRow
 */
export function resolveMarketplaceSyncJobAlreadyComplete(jobRow) {
  const pc = Number(jobRow?.progress_current ?? NaN);
  const pt = Number(jobRow?.progress_total ?? NaN);
  if (!Number.isFinite(pc) || !Number.isFinite(pt) || pt <= 0) return false;
  return pc >= pt;
}

/**
 * Garante progress_current <= progress_total quando ambos existem (API ML pode divergir do total).
 * @param {Record<string, unknown>} patch
 */
function clampProgressPatch(patch) {
  const next = { ...patch };
  if (next.progress_current != null && next.progress_total != null) {
    const pc = Number(next.progress_current);
    const pt = Number(next.progress_total);
    if (Number.isFinite(pc) && Number.isFinite(pt) && pt >= 0 && pc > pt) {
      next.progress_current = pt;
    }
  }
  return next;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 */
async function loadJobMetadataFromDb(supabase, jobId) {
  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("metadata")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return readJobMetadataObject(data);
}

/**
 * Claim atômico + lease (substitui pending→running não exclusivo).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function ensureMarketplaceSyncJobRunning(supabase, job) {
  return tryClaimMarketplaceSyncJob(supabase, job);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 * @param {{ existingJob?: Record<string, unknown>; skipLeaseRenew?: boolean }} [opts]
 */
export async function patchMarketplaceSyncJob(supabase, jobId, patch, opts = {}) {
  const nowIso = new Date().toISOString();
  const safe = clampProgressPatch(patch);
  /** @type {Record<string, unknown>} */
  const rowPatch = {
    ...safe,
    updated_at: nowIso,
  };

  if (safe.metadata && typeof safe.metadata === "object" && !Array.isArray(safe.metadata)) {
    const existingMeta = opts.existingJob
      ? readJobMetadataObject(opts.existingJob)
      : await loadJobMetadataFromDb(supabase, jobId);
    const patchMeta = /** @type {Record<string, unknown>} */ (safe.metadata);
    const merged = mergeOperationalSyncJobMetadata(existingMeta, patchMeta);
    // Soft yield / continuation must NOT renew lease — otherwise the worker exits while
    // the job looks "freshly leased" and stale recovery is delayed or skipped.
    const softYieldPatch = patchMeta.soft_yield_reason != null && String(patchMeta.soft_yield_reason).trim() !== "";
    const skipRenew = opts.skipLeaseRenew === true || softYieldPatch;
    rowPatch.metadata = skipRenew
      ? merged
      : buildLeaseHeartbeatMetadataPatch(merged, resolveSyncExecutorId(), Date.now());
  }

  const { error } = await supabase.from("marketplace_account_sync_jobs").update(rowPatch).eq("id", jobId);
  if (error) throw error;
}

/**
 * CPJ2 T16 — após soft yield / turno incompleto: libera lease e recola como pending
 * para retomada automática no próximo drain (sem depender de stale recovery por horas).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 * @param {{
 *   existingJob?: Record<string, unknown>;
 *   soft_yield_reason?: string;
 *   extraMeta?: Record<string, unknown>;
 * }} [opts]
 * @returns {Promise<{ released: boolean }>}
 */
export async function releaseMarketplaceSyncJobForContinuation(supabase, jobId, opts = {}) {
  const id = String(jobId || "").trim();
  if (!id) return { released: false };

  const nowIso = new Date().toISOString();
  const existingMeta = opts.existingJob
    ? readJobMetadataObject(opts.existingJob)
    : await loadJobMetadataFromDb(supabase, id);
  const reason =
    opts.soft_yield_reason != null && String(opts.soft_yield_reason).trim() !== ""
      ? String(opts.soft_yield_reason).trim()
      : existingMeta.soft_yield_reason != null && String(existingMeta.soft_yield_reason).trim() !== ""
        ? String(existingMeta.soft_yield_reason).trim()
        : "turn_budget_exhausted";
  const extra = opts.extraMeta && typeof opts.extraMeta === "object" ? opts.extraMeta : {};

  /** @type {Record<string, unknown>} */
  const metadata = {
    ...existingMeta,
    ...extra,
    soft_yield_reason: reason,
    soft_yield_at: nowIso,
    lease_owner: null,
    lease_expires_at: null,
  };

  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "pending",
      finished_at: null,
      error_message: null,
      updated_at: nowIso,
      metadata,
    })
    .eq("id", id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (data?.id) {
    console.info("[S7][marketplace-sync-soft-yield-released]", {
      job_id: id,
      soft_yield_reason: reason,
    });
    return { released: true };
  }
  return { released: false };
}

/**
 * Heartbeat explícito durante processamento (preserva metadata existente).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {Record<string, unknown>} [extraMeta]
 */
export async function heartbeatMarketplaceSyncJob(supabase, job, extraMeta = {}) {
  await touchMarketplaceSyncJobHeartbeat(supabase, job, extraMeta);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 * @param {{ existingJob?: Record<string, unknown> }} [opts]
 */
export async function completeMarketplaceSyncJob(supabase, jobId, patch, opts = {}) {
  const nowIso = new Date().toISOString();
  const safe = clampProgressPatch(patch);
  const existingMeta = opts.existingJob
    ? readJobMetadataObject(opts.existingJob)
    : await loadJobMetadataFromDb(supabase, jobId);
  const patchMeta =
    safe.metadata && typeof safe.metadata === "object" && !Array.isArray(safe.metadata)
      ? /** @type {Record<string, unknown>} */ (safe.metadata)
      : {};
  const metaBase = mergeOperationalSyncJobMetadata(existingMeta, patchMeta);
  const { error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "done",
      finished_at: nowIso,
      updated_at: nowIso,
      error_message: null,
      ...safe,
      metadata: {
        ...metaBase,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: nowIso,
      },
    })
    .eq("id", jobId);

  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 * @param {string} message
 * @param {string} [logTag]
 */
export async function failMarketplaceSyncJob(supabase, jobId, message, logTag = "[ML_INITIAL_SYNC_JOB_ERROR]") {
  const nowIso = new Date().toISOString();
  console.error(logTag, { job_id: jobId, fatal: message });
  const metaBase = await loadJobMetadataFromDb(supabase, jobId);
  await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "error",
      finished_at: nowIso,
      updated_at: nowIso,
      error_message: String(message || "").slice(0, 2000),
      metadata: {
        ...metaBase,
        lease_owner: null,
        lease_expires_at: null,
        terminal_at: nowIso,
      },
    })
    .eq("id", jobId);
}

