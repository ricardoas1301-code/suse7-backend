// ======================================================================
// Lease / heartbeat / stale recovery — marketplace_account_sync_jobs
// SSOT lifecycle genérico (multi-marketplace). Estado de lease em metadata.
// ======================================================================

/** @typedef {{ heartbeat_at?: string | null; lease_expires_at?: string | null; lease_owner?: string | null; recovery_count?: number; runtime_env?: string | null; lease_version?: number; lease_claimed_at?: string | null; lease_handoff_from?: string | null; stale_recovery_reason?: string | null }} SyncJobLeaseMeta */

export function resolveSyncExecutorId() {
  const explicit =
    process.env.ML_SYNC_EXECUTOR_ID != null ? String(process.env.ML_SYNC_EXECUTOR_ID).trim() : "";
  if (explicit) return explicit.slice(0, 160);
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || "local";
  const host =
    process.env.VERCEL_URL != null && String(process.env.VERCEL_URL).trim() !== ""
      ? String(process.env.VERCEL_URL).trim()
      : process.env.HOSTNAME != null
        ? String(process.env.HOSTNAME).trim()
        : "local-host";
  const deploy =
    process.env.VERCEL_DEPLOYMENT_ID != null && String(process.env.VERCEL_DEPLOYMENT_ID).trim() !== ""
      ? String(process.env.VERCEL_DEPLOYMENT_ID).trim().slice(0, 12)
      : "no-deploy";
  return `${env}:${host}:${deploy}`.slice(0, 160);
}

export function resolveLeaseDurationMs() {
  return Math.min(
    30 * 60 * 1000,
    Math.max(60 * 1000, parseInt(process.env.ML_SYNC_LEASE_MS || "300000", 10) || 300000)
  );
}

/** Tempo sem heartbeat/lease válido antes de elegível a recovery (requeue). */
export function resolveStaleRecoveryThresholdMs() {
  return Math.min(
    24 * 60 * 60 * 1000,
    Math.max(
      resolveLeaseDurationMs() + 30 * 1000,
      parseInt(process.env.ML_SYNC_STALE_RECOVERY_MS || "900000", 10) || 900000
    )
  );
}

export function resolveMaxStaleRecoveries() {
  return Math.min(
    100,
    Math.max(1, parseInt(process.env.ML_SYNC_MAX_STALE_RECOVERIES || "12", 10) || 12)
  );
}

/** Heartbeat temporal máximo durante execução (volume OU tempo — o que ocorrer primeiro). */
export function resolveHeartbeatIntervalMs() {
  const leaseMs = resolveLeaseDurationMs();
  const raw = parseInt(process.env.ML_SYNC_HEARTBEAT_INTERVAL_MS || "45000", 10);
  const interval = Number.isFinite(raw) ? raw : 45000;
  return Math.min(leaseMs - 10_000, Math.max(10_000, interval));
}

/** Orders processados entre heartbeats (par com intervalo temporal). */
export function resolveHeartbeatOrderBatch() {
  return Math.min(
    50,
    Math.max(1, parseInt(process.env.MARKETPLACE_SYNC_SALES_PROGRESS_HEARTBEAT_EVERY || "8", 10) || 8)
  );
}

/** Valida invariante: heartbeat < lease < stale recovery. */
export function assertHeartbeatLeaseTimingInvariant() {
  const hb = resolveHeartbeatIntervalMs();
  const lease = resolveLeaseDurationMs();
  const stale = resolveStaleRecoveryThresholdMs();
  if (!(hb < lease && lease < stale)) {
    throw new Error(`heartbeat_lease_stale_invariant_violated:${hb}<${lease}<${stale}`);
  }
  return { heartbeat_interval_ms: hb, lease_duration_ms: lease, stale_recovery_threshold_ms: stale };
}

/** Campos de lease/recovery que não podem ser apagados por merge operacional acidental. */
export const SYNC_JOB_LEASE_METADATA_KEYS = [
  "heartbeat_at",
  "lease_expires_at",
  "lease_owner",
  "lease_version",
  "recovery_count",
  "lease_claimed_at",
  "lease_handoff_from",
  "runtime_env",
  "stale_recovery_reason",
  "last_stale_at",
  "terminal_at",
];

/**
 * Merge seguro: patch operacional sobrescreve campos explícitos; lease preservado se omitido no patch.
 * @param {Record<string, unknown>} existingMeta
 * @param {Record<string, unknown>} patchMeta
 */
export function mergeOperationalSyncJobMetadata(existingMeta, patchMeta) {
  const existing = existingMeta && typeof existingMeta === "object" ? { ...existingMeta } : {};
  const patch = patchMeta && typeof patchMeta === "object" ? { ...patchMeta } : {};
  const merged = { ...existing, ...patch };
  for (const key of SYNC_JOB_LEASE_METADATA_KEYS) {
    if (!(key in patch) && key in existing) {
      merged[key] = existing[key];
    }
  }
  return merged;
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 */
export function validateLeaseMetadataPreserved(before, after) {
  const issues = [];
  for (const key of SYNC_JOB_LEASE_METADATA_KEYS) {
    if (key === "heartbeat_at" || key === "lease_expires_at") continue;
    if (before[key] != null && after[key] == null) {
      issues.push(`lost_${key}`);
    }
  }
  const bv = Number(before.lease_version);
  const av = Number(after.lease_version);
  if (Number.isFinite(bv) && Number.isFinite(av) && av < bv) {
    issues.push("lease_version_regressed");
  }
  const br = Number(before.recovery_count);
  const ar = Number(after.recovery_count);
  if (Number.isFinite(br) && Number.isFinite(ar) && ar < br) {
    issues.push("recovery_count_regressed");
  }
  return { ok: issues.length === 0, issues };
}

/** @param {Record<string, unknown> | null | undefined} job */
export function readJobMetadataObject(job) {
  if (!job || typeof job !== "object") return {};
  const meta = job.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return /** @type {Record<string, unknown>} */ ({ ...meta });
  }
  return {};
}

/** @param {Record<string, unknown> | null | undefined} job @returns {SyncJobLeaseMeta} */
export function readJobLeaseMeta(job) {
  const meta = readJobMetadataObject(job);
  const recoveryRaw = meta.recovery_count;
  return {
    heartbeat_at: meta.heartbeat_at != null ? String(meta.heartbeat_at) : null,
    lease_expires_at: meta.lease_expires_at != null ? String(meta.lease_expires_at) : null,
    lease_owner: meta.lease_owner != null ? String(meta.lease_owner) : null,
    recovery_count: Number.isFinite(Number(recoveryRaw)) ? Number(recoveryRaw) : 0,
    runtime_env: meta.runtime_env != null ? String(meta.runtime_env) : null,
    lease_version: Number.isFinite(Number(meta.lease_version)) ? Number(meta.lease_version) : 0,
    lease_claimed_at: meta.lease_claimed_at != null ? String(meta.lease_claimed_at) : null,
    lease_handoff_from: meta.lease_handoff_from != null ? String(meta.lease_handoff_from) : null,
    stale_recovery_reason: meta.stale_recovery_reason != null ? String(meta.stale_recovery_reason) : null,
  };
}

/**
 * @param {Record<string, unknown>} job
 * @param {number} [nowMs]
 */
export function isJobLeaseExpired(job, nowMs = Date.now()) {
  const lease = readJobLeaseMeta(job);
  if (lease.lease_expires_at) {
    const exp = Date.parse(lease.lease_expires_at);
    if (Number.isFinite(exp) && nowMs > exp) return true;
    if (Number.isFinite(exp) && nowMs <= exp) return false;
  }
  const hbRaw = lease.heartbeat_at || job.updated_at || job.started_at;
  if (!hbRaw) return true;
  const hbMs = Date.parse(String(hbRaw));
  if (!Number.isFinite(hbMs)) return true;
  return nowMs - hbMs > resolveStaleRecoveryThresholdMs();
}

/**
 * @param {Record<string, unknown>} job
 * @param {string} [executorId]
 * @param {number} [nowMs]
 */
export function canExecutorClaimJob(job, executorId = resolveSyncExecutorId(), nowMs = Date.now()) {
  const status = String(job.status || "").toLowerCase();
  if (status === "pending") return true;
  if (status !== "running") return false;
  const lease = readJobLeaseMeta(job);
  if (lease.lease_owner && lease.lease_owner === executorId && !isJobLeaseExpired(job, nowMs)) {
    return true;
  }
  return isJobLeaseExpired(job, nowMs);
}

/**
 * Renova heartbeat/lease durante execução — NÃO incrementa lease_version (CAS reservado ao claim).
 * @param {Record<string, unknown>} baseMeta
 * @param {string} executorId
 * @param {number} nowMs
 */
export function buildLeaseHeartbeatMetadataPatch(baseMeta, executorId, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const leaseExpires = new Date(nowMs + resolveLeaseDurationMs()).toISOString();
  const version = Number.isFinite(Number(baseMeta.lease_version)) ? Number(baseMeta.lease_version) : 0;
  return {
    ...baseMeta,
    heartbeat_at: nowIso,
    lease_expires_at: leaseExpires,
    lease_owner: executorId,
    runtime_env: process.env.VERCEL_ENV || process.env.NODE_ENV || "local",
    lease_version: version,
  };
}

/**
 * Claim/handoff — incrementa lease_version (CAS).
 * @param {Record<string, unknown>} baseMeta
 * @param {string} executorId
 * @param {number} nowMs
 * @param {{ handoffFrom?: string | null; recoveryReason?: string | null }} [opts]
 */
export function buildLeaseClaimMetadataPatch(baseMeta, executorId, nowMs, opts = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const leaseExpires = new Date(nowMs + resolveLeaseDurationMs()).toISOString();
  const version = Number.isFinite(Number(baseMeta.lease_version)) ? Number(baseMeta.lease_version) : 0;
  /** @type {Record<string, unknown>} */
  const next = {
    ...baseMeta,
    heartbeat_at: nowIso,
    lease_expires_at: leaseExpires,
    lease_owner: executorId,
    lease_claimed_at: nowIso,
    lease_version: version + 1,
    runtime_env: process.env.VERCEL_ENV || process.env.NODE_ENV || "local",
  };
  if (opts.handoffFrom) next.lease_handoff_from = opts.handoffFrom;
  if (opts.recoveryReason) next.stale_recovery_reason = opts.recoveryReason;
  return next;
}

/** @deprecated use buildLeaseClaimMetadataPatch or buildLeaseHeartbeatMetadataPatch */
export function buildLeaseMetadataPatch(baseMeta, executorId, nowMs, opts = {}) {
  if (opts.handoffFrom || opts.recoveryReason) {
    return buildLeaseClaimMetadataPatch(baseMeta, executorId, nowMs, opts);
  }
  return buildLeaseHeartbeatMetadataPatch(baseMeta, executorId, nowMs);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} metadata
 */
export async function renewMarketplaceSyncJobLease(supabase, jobId, metadata) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      updated_at: nowIso,
      metadata,
    })
    .eq("id", jobId)
    .eq("status", "running");

  if (error) throw error;
}

/**
 * Tenta claim atômico (pending→running ou running com lease expirado / mesmo owner).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function tryClaimMarketplaceSyncJob(supabase, job) {
  const jobId = job.id != null ? String(job.id) : "";
  if (!jobId) return null;

  const executorId = resolveSyncExecutorId();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const status = String(job.status || "").toLowerCase();

  if (status === "pending") {
    const meta = buildLeaseClaimMetadataPatch(readJobMetadataObject(job), executorId, nowMs);
    const { data, error } = await supabase
      .from("marketplace_account_sync_jobs")
      .update({
        status: "running",
        started_at: job.started_at ?? nowIso,
        updated_at: nowIso,
        finished_at: null,
        error_message: null,
        metadata: meta,
      })
      .eq("id", jobId)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (data) {
      console.info("[S7][marketplace-sync-job-claim]", {
        job_id: jobId,
        marketplace_account_id: job.marketplace_account_id ?? null,
        job_type: job.job_type ?? null,
        claim: "pending_to_running",
        lease_owner: executorId,
      });
      return data;
    }
    return null;
  }

  if (status !== "running") return null;

  const { data: fresh, error: freshErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (freshErr) throw freshErr;
  if (!fresh?.id || String(fresh.status || "").toLowerCase() !== "running") return null;

  const lease = readJobLeaseMeta(fresh);
  const expired = isJobLeaseExpired(fresh, nowMs);

  if (lease.lease_owner === executorId && !expired) {
    const meta = buildLeaseHeartbeatMetadataPatch(readJobMetadataObject(fresh), executorId, nowMs);
    await renewMarketplaceSyncJobLease(supabase, jobId, meta);
    const { data: renewed } = await supabase.from("marketplace_account_sync_jobs").select("*").eq("id", jobId).maybeSingle();
    return renewed ?? fresh;
  }

  if (!expired && lease.lease_owner && lease.lease_owner !== executorId) {
    console.info("[S7][marketplace-sync-job-claim-skipped]", {
      job_id: jobId,
      reason: "lease_held_by_other_executor",
      lease_owner: lease.lease_owner,
      executor_id: executorId,
      lease_expires_at: lease.lease_expires_at,
    });
    return null;
  }

  const meta = buildLeaseClaimMetadataPatch(readJobMetadataObject(fresh), executorId, nowMs, {
    handoffFrom: lease.lease_owner && lease.lease_owner !== executorId ? lease.lease_owner : null,
  });
  const version = lease.lease_version ?? 0;
  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      updated_at: nowIso,
      finished_at: null,
      error_message: null,
      metadata: meta,
    })
    .eq("id", jobId)
    .eq("status", "running")
    .filter("metadata->>lease_version", "eq", String(version))
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (data) {
    console.info("[S7][marketplace-sync-job-claim]", {
      job_id: jobId,
      marketplace_account_id: job.marketplace_account_id ?? null,
      job_type: job.job_type ?? null,
      claim: lease.lease_owner ? "running_lease_handoff" : "running_lease_reclaim",
      lease_owner: executorId,
      handoff_from: lease.lease_owner ?? null,
      lease_version: version + 1,
    });
    return data;
  }

  if (expired) {
    const legacyQuery = supabase
      .from("marketplace_account_sync_jobs")
      .update({
        updated_at: nowIso,
        finished_at: null,
        error_message: null,
        metadata: buildLeaseClaimMetadataPatch(readJobMetadataObject(fresh), executorId, nowMs, {
          handoffFrom: lease.lease_owner ?? null,
        }),
      })
      .eq("id", jobId)
      .eq("status", "running")
      .is("metadata->lease_version", null)
      .select("*")
      .maybeSingle();
    const { data: legacyData, error: legacyErr } = await legacyQuery;
    if (legacyErr) throw legacyErr;
    if (legacyData) {
      console.info("[S7][marketplace-sync-job-claim]", {
        job_id: jobId,
        claim: "running_lease_reclaim_legacy_no_version",
        lease_owner: executorId,
        handoff_from: lease.lease_owner ?? null,
      });
      return legacyData;
    }
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {Record<string, unknown>} [extraMeta]
 */
export async function touchMarketplaceSyncJobHeartbeat(supabase, job, extraMeta = {}) {
  const jobId = job.id != null ? String(job.id) : "";
  if (!jobId) return;
  const executorId = resolveSyncExecutorId();
  const lease = readJobLeaseMeta(job);
  if (lease.lease_owner && lease.lease_owner !== executorId) return;

  const meta = buildLeaseHeartbeatMetadataPatch(
    mergeOperationalSyncJobMetadata(readJobMetadataObject(job), extraMeta),
    executorId,
    Date.now()
  );
  await renewMarketplaceSyncJobLease(supabase, jobId, meta);
}

const STALE_ERROR_PREFIX = "stale_running_timeout";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function recoverStaleMarketplaceSyncJobs(supabase) {
  const nowMs = Date.now();
  const thresholdMs = resolveStaleRecoveryThresholdMs();
  const maxRecoveries = resolveMaxStaleRecoveries();
  const cutoffIso = new Date(nowMs - thresholdMs).toISOString();

  /** @type {{ running_requeued: number; error_requeued: number; terminal: number }} */
  const stats = { running_requeued: 0, error_requeued: 0, terminal: 0 };

  const { data: runningRows, error: runErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("*")
    .eq("status", "running")
    .limit(200);

  if (runErr) {
    console.warn("[S7][marketplace-sync-stale-recovery-warn]", { message: runErr.message });
    return stats;
  }

  for (const row of runningRows ?? []) {
    const lease = readJobLeaseMeta(row);
    const hb = lease.heartbeat_at || row.updated_at || row.started_at;
    const hbMs = hb ? Date.parse(String(hb)) : NaN;
    const staleByHeartbeat = !Number.isFinite(hbMs) || nowMs - hbMs > thresholdMs;
    const staleByLease = isJobLeaseExpired(row, nowMs);
    if (!staleByHeartbeat && !staleByLease) continue;

    const nextRecovery = (lease.recovery_count || 0) + 1;
    if (nextRecovery > maxRecoveries) {
      const nowIso = new Date().toISOString();
      await supabase
        .from("marketplace_account_sync_jobs")
        .update({
          status: "error",
          finished_at: nowIso,
          updated_at: nowIso,
          error_message: `stale_recovery_limit_exceeded>${maxRecoveries}`,
          metadata: {
            ...readJobMetadataObject(row),
            recovery_count: nextRecovery,
            stale_recovery_reason: "max_recoveries_exceeded",
            last_stale_at: nowIso,
          },
        })
        .eq("id", row.id)
        .eq("status", "running");
      stats.terminal += 1;
      continue;
    }

    const nowIso = new Date().toISOString();
    const meta = {
      ...readJobMetadataObject(row),
      recovery_count: nextRecovery,
      stale_recovery_reason: "heartbeat_or_lease_expired",
      last_stale_at: nowIso,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: hb ?? cutoffIso,
    };
    const { error: updErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .update({
        status: "pending",
        finished_at: null,
        error_message: null,
        updated_at: nowIso,
        metadata: meta,
      })
      .eq("id", row.id)
      .eq("status", "running");

    if (!updErr) {
      stats.running_requeued += 1;
      console.warn("[S7][marketplace-sync-stale-requeued]", {
        job_id: row.id,
        marketplace_account_id: row.marketplace_account_id ?? null,
        job_type: row.job_type ?? null,
        recovery_count: nextRecovery,
        progress_current: row.progress_current ?? null,
        progress_total: row.progress_total ?? null,
      });
    }
  }

  const { data: errorRows, error: errQ } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("*")
    .eq("status", "error")
    .like("error_message", `${STALE_ERROR_PREFIX}%`)
    .limit(100);

  if (errQ) {
    console.warn("[S7][marketplace-sync-stale-error-recovery-warn]", { message: errQ.message });
    return stats;
  }

  for (const row of errorRows ?? []) {
    const lease = readJobLeaseMeta(row);
    const nextRecovery = (lease.recovery_count || 0) + 1;
    if (nextRecovery > maxRecoveries) {
      stats.terminal += 1;
      continue;
    }

    const nowIso = new Date().toISOString();
    const meta = {
      ...readJobMetadataObject(row),
      recovery_count: nextRecovery,
      stale_recovery_reason: "requeue_from_stale_error",
      last_stale_at: nowIso,
      lease_owner: null,
      lease_expires_at: null,
    };
    const { error: updErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .update({
        status: "pending",
        finished_at: null,
        error_message: null,
        started_at: row.started_at ?? row.created_at ?? nowIso,
        updated_at: nowIso,
        metadata: meta,
      })
      .eq("id", row.id)
      .eq("status", "error");

    if (!updErr) {
      stats.error_requeued += 1;
      console.warn("[S7][marketplace-sync-stale-error-requeued]", {
        job_id: row.id,
        marketplace_account_id: row.marketplace_account_id ?? null,
        job_type: row.job_type ?? null,
        recovery_count: nextRecovery,
        prior_error: row.error_message ?? null,
      });
    }
  }

  return stats;
}
