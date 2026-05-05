// ======================================================================
// Helpers compartilhados para marketplace_account_sync_jobs (worker + onboarding ML).
// ======================================================================

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
  const { error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      ...patch,
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
  const { error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "done",
      finished_at: nowIso,
      updated_at: nowIso,
      error_message: null,
      ...patch,
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
