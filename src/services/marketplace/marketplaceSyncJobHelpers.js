// ======================================================================
// Helpers compartilhados para marketplace_account_sync_jobs (worker + onboarding ML).
// ======================================================================

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
 * @param {Record<string, unknown>} job
 */
export async function ensureMarketplaceSyncJobRunning(supabase, job) {
  const nowIso = new Date().toISOString();
  if (String(job.status || "") !== "pending") return job;

  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "running",
      started_at: job.started_at ?? nowIso,
      updated_at: nowIso,
      error_message: null,
    })
    .eq("id", job.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (!error && data) return data;

  const { data: fresh } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("*")
    .eq("id", job.id)
    .maybeSingle();

  return fresh ?? job;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
export async function patchMarketplaceSyncJob(supabase, jobId, patch) {
  const nowIso = new Date().toISOString();
  const safe = clampProgressPatch(patch);
  const { error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      ...safe,
      updated_at: nowIso,
    })
    .eq("id", jobId);

  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
export async function completeMarketplaceSyncJob(supabase, jobId, patch) {
  const nowIso = new Date().toISOString();
  const safe = clampProgressPatch(patch);
  const { error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "done",
      finished_at: nowIso,
      updated_at: nowIso,
      error_message: null,
      ...safe,
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
  await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "error",
      finished_at: nowIso,
      updated_at: nowIso,
      error_message: String(message || "").slice(0, 2000),
    })
    .eq("id", jobId);
}
