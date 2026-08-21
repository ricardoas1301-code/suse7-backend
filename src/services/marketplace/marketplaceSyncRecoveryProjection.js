// ======================================================================
// Projeção read-only de stale recovery — paridade dry-run × worker real.
// Escrita permanece em recoverStaleMarketplaceSyncJobs().
// ======================================================================

import {
  isJobLeaseExpired,
  readJobLeaseMeta,
  readJobMetadataObject,
  resolveMaxStaleRecoveries,
  resolveStaleRecoveryThresholdMs,
} from "./marketplaceSyncJobLease.js";

/**
 * @param {Record<string, unknown>} row
 * @param {number} [nowMs]
 * @returns {{
 *   changed: boolean;
 *   recovery_action: "requeue" | "terminal" | null;
 *   projected: Record<string, unknown>;
 * }}
 */
export function projectStaleRunningRecovery(row, nowMs = Date.now()) {
  const status = String(row.status || "").toLowerCase();
  if (status !== "running") {
    return { changed: false, recovery_action: null, projected: row };
  }

  const lease = readJobLeaseMeta(row);
  const thresholdMs = resolveStaleRecoveryThresholdMs();
  const hb = lease.heartbeat_at || row.updated_at || row.started_at;
  const hbMs = hb ? Date.parse(String(hb)) : NaN;
  const staleByHeartbeat = !Number.isFinite(hbMs) || nowMs - hbMs > thresholdMs;
  const staleByLease = isJobLeaseExpired(row, nowMs);
  if (!staleByHeartbeat && !staleByLease) {
    return { changed: false, recovery_action: null, projected: row };
  }

  const maxRecoveries = resolveMaxStaleRecoveries();
  const nextRecovery = (lease.recovery_count || 0) + 1;
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - thresholdMs).toISOString();

  if (nextRecovery > maxRecoveries) {
    return {
      changed: true,
      recovery_action: "terminal",
      projected: {
        ...row,
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
      },
    };
  }

  const meta = {
    ...readJobMetadataObject(row),
    recovery_count: nextRecovery,
    stale_recovery_reason: "heartbeat_or_lease_expired",
    last_stale_at: nowIso,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: hb ?? cutoffIso,
  };

  return {
    changed: true,
    recovery_action: "requeue",
    projected: {
      ...row,
      status: "pending",
      finished_at: null,
      error_message: null,
      updated_at: nowIso,
      metadata: meta,
    },
  };
}

/**
 * Aplica projeção de recovery somente em jobs running do pool (read-only).
 * @param {Record<string, unknown>[]} rows
 * @param {number} [nowMs]
 */
export function projectPoolAfterStaleRecovery(rows, nowMs = Date.now()) {
  return (rows ?? []).map((row) => projectStaleRunningRecovery(row, nowMs).projected);
}

/**
 * Filtra linhas elegíveis para o selector após projeção (pending/running).
 * @param {Record<string, unknown>[]} rows
 */
export function filterActivePoolRowsAfterRecoveryProjection(rows) {
  return (rows ?? []).filter((row) => {
    const s = String(row.status || "").toLowerCase();
    return s === "pending" || s === "running";
  });
}
