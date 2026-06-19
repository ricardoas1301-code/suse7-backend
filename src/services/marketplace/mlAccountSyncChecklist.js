// ======================================================================
// Checklist ML onboarding + agregados (hot vs histórico) — compartilhado
// entre GET sync-status e GET import-intelligence.
// ======================================================================

import { ML_SALES_HOT_TYPES } from "./createMlInitialSyncJobs.js";

/**
 * @type {{ key: string; label: string; job_types: string[] | null; aggregateHistorical?: boolean; sync_layer: "account" | "hot" | "historical" }[]}
 */
export const ML_ACCOUNT_SYNC_CHECKLIST_DEFS = [
  { key: "ml_connect", label: "Conectando conta Mercado Livre", job_types: null, sync_layer: "account" },
  {
    key: "sales_recent",
    label: "Vendas recentes",
    job_types: [...ML_SALES_HOT_TYPES],
    sync_layer: "hot",
  },
  {
    key: "listings",
    label: "Anúncios",
    job_types: ["ml_initial_listings_current", "ml_initial_listings"],
    sync_layer: "hot",
  },
  { key: "fees", label: "Taxas", job_types: ["ml_initial_fees"], sync_layer: "hot" },
  { key: "products", label: "Produtos/SKU", job_types: ["ml_initial_products"], sync_layer: "hot" },
  {
    key: "customers",
    label: "Clientes 360",
    job_types: ["ml_initial_customers_recent", "ml_initial_customers"],
    sync_layer: "hot",
  },
  {
    key: "monitoring",
    label: "Webhook/monitoramento",
    job_types: ["ml_enable_webhook_monitoring"],
    sync_layer: "hot",
  },
  {
    key: "historical_sales",
    label: "Histórico de vendas",
    job_types: ["ml_historical_sales_backfill"],
    aggregateHistorical: true,
    sync_layer: "historical",
  },
];

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} jobType
 */
export function pickLatestJob(rows, jobType) {
  const list = rows.filter((r) => String(r.job_type || "") === jobType);
  list.sort((a, b) => {
    const ta = new Date(/** @type {string} */ (a.created_at || 0)).getTime();
    const tb = new Date(/** @type {string} */ (b.created_at || 0)).getTime();
    return tb - ta;
  });
  return list[0] ?? null;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string[]} types
 */
export function pickLatestAmong(rows, types) {
  if (!types?.length) return null;
  /** @type {Record<string, unknown> | null} */
  let best = null;
  let bestTs = -Infinity;
  for (const t of types) {
    const j = pickLatestJob(rows, t);
    if (!j) continue;
    const ts = Date.parse(String(j.created_at || 0));
    if (Number.isFinite(ts) && ts >= bestTs) {
      bestTs = ts;
      best = j;
    }
  }
  return best;
}

/**
 * @param {Record<string, unknown>[]} rows
 */
export function aggregateHistoricalSalesJobs(rows) {
  const hs = rows.filter((r) => String(r.job_type || "") === "ml_historical_sales_backfill");
  if (hs.length === 0) return null;
  const states = hs.map((r) => String(r.status || "").toLowerCase());
  let status = "pending";
  if (states.some((s) => s === "running")) status = "running";
  else if (states.some((s) => s === "error")) status = "error";
  else if (states.every((s) => s === "done")) status = "done";
  const pc = hs.reduce((a, r) => a + (Number(r.progress_current) || 0), 0);
  const pt = hs.reduce((a, r) => a + (Number(r.progress_total) || 0), 0);
  const doneWindows = hs.filter((r) => String(r.status || "").toLowerCase() === "done").length;
  return {
    status,
    progress_current: pc,
    progress_total: pt > 0 ? pt : hs.length,
    windows_total: hs.length,
    windows_done: doneWindows,
    windows_pending: hs.filter((r) => String(r.status || "").toLowerCase() === "pending").length,
    windows_running: hs.filter((r) => String(r.status || "").toLowerCase() === "running").length,
  };
}

/**
 * @param {Record<string, unknown>[]} rows
 */
export function aggregateHistoricalCustomersJobs(rows) {
  const hs = rows.filter((r) => String(r.job_type || "") === "ml_historical_customers_backfill");
  if (hs.length === 0) return null;
  const states = hs.map((r) => String(r.status || "").toLowerCase());
  let status = "pending";
  if (states.some((s) => s === "running")) status = "running";
  else if (states.some((s) => s === "error")) status = "error";
  else if (states.every((s) => s === "done")) status = "done";
  const pc = hs.reduce((a, r) => a + (Number(r.progress_current) || 0), 0);
  const pt = hs.reduce((a, r) => a + (Number(r.progress_total) || 0), 0);
  return {
    status,
    progress_current: pc,
    progress_total: pt > 0 ? pt : hs.length,
    windows_total: hs.length,
    windows_done: hs.filter((r) => String(r.status || "").toLowerCase() === "done").length,
  };
}

/**
 * @param {Record<string, unknown>} account — precisa id, status
 * @param {Record<string, unknown>[]} rows — jobs da conta
 */
export function buildMlAccountSyncChecklist(account, rows) {
  const historicalSalesAgg = aggregateHistoricalSalesJobs(rows);

  /** @type {Record<string, unknown>[]} */
  const checklist = [];

  for (const def of ML_ACCOUNT_SYNC_CHECKLIST_DEFS) {
    if (def.job_types == null) {
      const st = String(account.status || "").toLowerCase() === "active" ? "done" : "pending";
      checklist.push({
        key: def.key,
        label: def.label,
        sync_layer: def.sync_layer,
        job_types: null,
        job_type: null,
        status: st,
        progress_current: null,
        progress_total: null,
        error_message: null,
        metadata: {},
      });
      continue;
    }

    if (def.aggregateHistorical) {
      const agg = historicalSalesAgg;
      const st = agg?.status != null ? String(agg.status) : "pending";
      checklist.push({
        key: def.key,
        label: def.label,
        sync_layer: def.sync_layer,
        job_types: def.job_types,
        job_type: def.job_types[0],
        status: st,
        progress_current: agg?.progress_current ?? null,
        progress_total: agg?.progress_total ?? null,
        error_message: null,
        metadata: {},
        historical_aggregate: agg ?? undefined,
      });
      continue;
    }

    const job = pickLatestAmong(rows, def.job_types);
    const st = job?.status != null ? String(job.status) : "pending";
    checklist.push({
      key: def.key,
      label: def.label,
      sync_layer: def.sync_layer,
      job_types: def.job_types,
      job_type: job ? String(job.job_type) : def.job_types[0],
      status: st,
      progress_current: job?.progress_current ?? null,
      progress_total: job?.progress_total ?? null,
      error_message: job?.error_message ?? null,
      metadata: job?.metadata && typeof job.metadata === "object" ? job.metadata : {},
    });
  }

  const gateStatuses = checklist
    .filter((x) => String(x.sync_layer || "") !== "historical")
    .map((x) => String(x.status || ""));
  const hotAllDone = gateStatuses.length > 0 && gateStatuses.every((s) => s === "done");

  return { checklist, historicalSalesAgg, hotAllDone, hasEngagedInitialSync: rows.length > 0 };
}
