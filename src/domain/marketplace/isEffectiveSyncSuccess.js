// ======================================================================
// Sucesso operacional real de job de sync marketplace.
// Maintenance stub (done + skipped + DEV_GLOBAL_MAINTENANCE) NÃO conta.
// ======================================================================

import { DEV_GLOBAL_MAINTENANCE_REASON } from "../dev/devGlobalMaintenanceMode.js";

const DONE_STATUSES = new Set(["done", "completed"]);
const ACTIVE_STATUSES = new Set(["pending", "queued", "running", "processing"]);

/**
 * @param {unknown} job
 * @returns {Record<string, unknown>}
 */
function readJobMetadata(job) {
  const meta = job && typeof job === "object" ? /** @type {Record<string, unknown>} */ (job).metadata : null;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return /** @type {Record<string, unknown>} */ (meta);
  }
  return {};
}

/**
 * Job terminalizado como stub de maintenance (evidência histórica válida, não sucesso real).
 * @param {unknown} job
 */
export function isMaintenanceSkippedSyncJob(job) {
  if (!job || typeof job !== "object") return false;
  const st = String(/** @type {Record<string, unknown>} */ (job).status || "")
    .trim()
    .toLowerCase();
  if (!DONE_STATUSES.has(st)) return false;
  const meta = readJobMetadata(job);
  if (meta.skipped !== true) return false;
  const reason = String(meta.reason ?? "").trim();
  return reason === DEV_GLOBAL_MAINTENANCE_REASON || reason === "DEV_GLOBAL_MAINTENANCE";
}

/**
 * Sucesso operacional real: done/completed sem skip de maintenance.
 * @param {unknown} job
 */
export function isEffectiveSyncSuccess(job) {
  if (!job || typeof job !== "object") return false;
  const st = String(/** @type {Record<string, unknown>} */ (job).status || "")
    .trim()
    .toLowerCase();
  if (!DONE_STATUSES.has(st)) return false;
  if (isMaintenanceSkippedSyncJob(job)) return false;
  return true;
}

/**
 * Status efetivo para checklist/agregação/OT (stubs de maintenance → pending).
 * @param {unknown} job
 * @returns {string}
 */
export function resolveEffectiveSyncJobStatus(job) {
  if (!job || typeof job !== "object") return "pending";
  if (isMaintenanceSkippedSyncJob(job)) return "pending";
  const st = String(/** @type {Record<string, unknown>} */ (job).status || "")
    .trim()
    .toLowerCase();
  return st || "pending";
}

/**
 * Conta engajou sync real (job ativo ou conclusão não-stub). Só stubs de maintenance → false.
 * @param {unknown[]} rows
 */
export function hasEngagedRealOrActiveSync(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  for (const job of rows) {
    if (!job || typeof job !== "object") continue;
    const st = String(/** @type {Record<string, unknown>} */ (job).status || "")
      .trim()
      .toLowerCase();
    if (ACTIVE_STATUSES.has(st)) return true;
    if (isMaintenanceSkippedSyncJob(job)) continue;
    return true;
  }
  return false;
}
