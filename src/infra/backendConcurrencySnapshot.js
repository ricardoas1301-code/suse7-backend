// ======================================================================
// DEV — snapshot de concorrência HTTP (burst multiaba / homologação)
// ======================================================================

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const isDevSnapshotEnabled =
  String(process.env.NODE_ENV ?? "").toLowerCase() !== "production" ||
  String(process.env.S7_BACKEND_CONCURRENCY_SNAPSHOT ?? "1") === "1";

/** @type {import("node:perf_hooks").IntervalHistogram | null} */
let eventLoopMonitor = null;
if (isDevSnapshotEnabled) {
  eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
  eventLoopMonitor.enable();
}

/** @type {number} */
let activeHttpRequests = 0;
/** @type {Map<string, number>} */
const activeByUser = new Map();
/** @type {Map<string, number>} */
const activeByEndpoint = new Map();

/**
 * @param {string} path
 */
function classifyEndpoint(path) {
  const p = String(path || "");
  if (p.includes("/api/billing/subscription/status")) return "billing_status";
  if (p.includes("/api/sales/executive-summary")) return "executive_summary";
  if (p.includes("/api/ml/listings")) return "ml_listings";
  if (p.includes("/api/products/catalog-financial")) return "catalog_financial";
  if (p.includes("/api/dashboard/listings-health-summary")) return "listings_health";
  return "other";
}

function getEventLoopLagMs() {
  if (!eventLoopMonitor) return null;
  return Math.round(eventLoopMonitor.mean / 1e6);
}

function getProcessMemoryMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

/**
 * @param {{ endpoint: string; userId?: string | null; requestId?: string }} meta
 */
export function beginBackendConcurrencySnapshot(meta) {
  const endpoint = classifyEndpoint(meta.endpoint);
  activeHttpRequests += 1;
  activeByEndpoint.set(endpoint, (activeByEndpoint.get(endpoint) ?? 0) + 1);

  const userId = meta.userId ? String(meta.userId) : null;
  if (userId) {
    activeByUser.set(userId, (activeByUser.get(userId) ?? 0) + 1);
  }

  return {
    requestId: meta.requestId ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    endpoint,
    userId,
    startedAt: Date.now(),
    startedPerf: performance.now(),
  };
}

/**
 * @param {{ requestId: string; endpoint: string; userId: string | null; startedAt: number }} ctx
 * @param {{ status?: number; httpStatus?: number }} [extra]
 */
export function finishBackendConcurrencySnapshot(ctx, extra = {}) {
  activeHttpRequests = Math.max(0, activeHttpRequests - 1);
  activeByEndpoint.set(ctx.endpoint, Math.max(0, (activeByEndpoint.get(ctx.endpoint) ?? 1) - 1));
  if (ctx.userId) {
    activeByUser.set(ctx.userId, Math.max(0, (activeByUser.get(ctx.userId) ?? 1) - 1));
  }

  if (!isDevSnapshotEnabled) return;

  const finishedAt = Date.now();
  const billingActive = activeByEndpoint.get("billing_status") ?? 0;
  const executiveActive = activeByEndpoint.get("executive_summary") ?? 0;

  console.info("[S7_BACKEND_CONCURRENCY_SNAPSHOT]", {
    request_id: ctx.requestId,
    endpoint: ctx.endpoint,
    user_id: ctx.userId,
    active_http_requests: activeHttpRequests,
    active_requests_for_user: ctx.userId ? activeByUser.get(ctx.userId) ?? 0 : 0,
    active_billing_requests: billingActive,
    active_executive_requests: executiveActive,
    queued_requests: 0,
    event_loop_lag_ms: getEventLoopLagMs(),
    process_memory_mb: getProcessMemoryMb(),
    started_at: new Date(ctx.startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: finishedAt - ctx.startedAt,
    status: extra.status ?? extra.httpStatus ?? null,
  });
}
