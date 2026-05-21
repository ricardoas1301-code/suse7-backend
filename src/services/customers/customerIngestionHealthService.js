// =============================================================================
// Clientes 360 — projeção read-only da saúde da ingestão (Fase 4A.2)
// Sem writer, sem persistência, sem PII em logs.
// =============================================================================

import { customerAggregateKey } from "./customerOrderAggregateService.js";
import {
  COVERAGE_DEGRADED_PCT,
  COVERAGE_HEALTHY_PCT,
  INGESTION_HEALTH_STATUS,
  PENDING_CRITICAL_COUNT,
  STALE_COMPARE_TOLERANCE_MS,
  STALE_CRITICAL_PCT,
  STALE_DEGRADED_PCT,
} from "./customerIngestionHealthConstants.js";

function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isMissingTableOrColumn(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("column");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("@supabase/supabase-js").PostgrestFilterBuilder<any, any, any>} q
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 */
function applySalesOrderScope(q, scope) {
  let next = q.eq("user_id", scope.userId);
  const mp = safeStr(scope.marketplace);
  const acc = safeStr(scope.marketplaceAccountId);
  const co = safeStr(scope.sellerCompanyId);
  if (mp) next = next.eq("marketplace", mp);
  if (acc) next = next.eq("marketplace_account_id", acc);
  if (co) next = next.eq("seller_company_id", co);
  return next;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 */
function applyMarketplaceCustomerScope(q, scope) {
  let next = q.eq("user_id", scope.userId);
  const mp = safeStr(scope.marketplace);
  const acc = safeStr(scope.marketplaceAccountId);
  const co = safeStr(scope.sellerCompanyId);
  if (mp) next = next.eq("marketplace", mp);
  if (acc) next = next.eq("marketplace_account_id", acc);
  if (co) next = next.eq("seller_company_id", co);
  return next;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 */
async function probeIngestionColumn(supabase) {
  const probe = await supabase.from("sales_orders").select("customer_ingested_at").limit(1);
  if (probe.error && isMissingTableOrColumn(probe.error)) return false;
  if (probe.error) throw probe.error;
  return true;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 */
async function countOrdersMetrics(supabase, scope) {
  const hasColumn = await probeIngestionColumn(supabase);
  if (!hasColumn) {
    return { available: false, totalWithBuyer: 0, materialized: 0, pending: 0 };
  }

  const totalQ = applySalesOrderScope(
    supabase.from("sales_orders").select("id", { count: "exact", head: true }),
    scope,
  );
  const pendingQ = applySalesOrderScope(
    supabase.from("sales_orders").select("id", { count: "exact", head: true }).is("customer_ingested_at", null),
    scope,
  );

  const [totalRes, pendingRes] = await Promise.all([totalQ, pendingQ]);

  if (totalRes.error) {
    if (isMissingTableOrColumn(totalRes.error)) {
      return { available: false, totalWithBuyer: 0, materialized: 0, pending: 0 };
    }
    throw totalRes.error;
  }
  if (pendingRes.error) {
    if (isMissingTableOrColumn(pendingRes.error)) {
      return { available: false, totalWithBuyer: 0, materialized: 0, pending: 0 };
    }
    throw pendingRes.error;
  }

  const totalWithBuyer = Number(totalRes.count ?? 0) || 0;
  const pending = Number(pendingRes.count ?? 0) || 0;
  const materialized = Math.max(0, totalWithBuyer - pending);

  return { available: true, totalWithBuyer, materialized, pending };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 */
async function countMaterializedCustomers(supabase, scope) {
  const q = applyMarketplaceCustomerScope(
    supabase.from("marketplace_customers").select("id", { count: "exact", head: true }),
    scope,
  );
  const { count, error } = await q;
  if (error) {
    if (isMissingTableOrColumn(error)) return { available: false, count: 0 };
    throw error;
  }
  return { available: true, count: Number(count ?? 0) || 0 };
}

/**
 * @param {Array<Record<string, unknown>>} customerRows
 * @param {Map<string, { last_purchase_at: string | null }>} aggregateMap
 */
export function countStaleCustomers(customerRows, aggregateMap) {
  let stale = 0;

  for (const row of customerRows) {
    const key = customerAggregateKey({
      marketplace: row.marketplace,
      marketplaceAccountId: row.marketplace_account_id,
      sellerCompanyId: row.seller_company_id,
      externalCustomerId: row.external_customer_id,
    });
    const agg = key ? aggregateMap.get(key) : null;
    const lastPurchaseAt = safeStr(agg?.last_purchase_at);
    if (!lastPurchaseAt) continue;

    const updatedMs = Date.parse(String(row.updated_at ?? ""));
    const lastPurchaseMs = Date.parse(lastPurchaseAt);
    if (!Number.isFinite(updatedMs) || !Number.isFinite(lastPurchaseMs)) continue;

    if (updatedMs + STALE_COMPARE_TOLERANCE_MS < lastPurchaseMs) {
      stale += 1;
    }
  }

  return stale;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 */
async function countGlobalSyncMetrics(supabase, scope) {
  try {
    const { data, error } = await supabase.from("s7_global_customers").select("related_sellers").limit(5000);

    if (error) {
      if (isMissingTableOrColumn(error)) {
        return { available: false, linked: null, pending: null };
      }
      console.warn("[Suse7][customers-health] global_query_failed", { code: error.code });
      return { available: false, linked: null, pending: null };
    }

    /** @type {Set<string>} */
    const linkedKeys = new Set();
    const mp = safeStr(scope.marketplace);
    const acc = safeStr(scope.marketplaceAccountId);
    const co = safeStr(scope.sellerCompanyId);

    for (const row of data ?? []) {
      const sellers = Array.isArray(row.related_sellers) ? row.related_sellers : [];
      for (const entry of sellers) {
        if (!entry || typeof entry !== "object") continue;
        if (String(entry.user_id) !== scope.userId) continue;
        if (mp && String(entry.marketplace ?? "") !== mp) continue;
        if (acc && String(entry.marketplace_account_id ?? "") !== acc) continue;
        if (co && String(entry.seller_company_id ?? "") !== co) continue;
        const ext = safeStr(entry.external_customer_id);
        if (!ext) continue;
        linkedKeys.add(
          `${String(entry.marketplace ?? "")}|${String(entry.marketplace_account_id ?? "")}|${String(entry.seller_company_id ?? "")}|${ext}`,
        );
      }
    }

    return { available: true, linked: linkedKeys.size, pending: null };
  } catch (e) {
    console.warn("[Suse7][customers-health] global_unavailable", {
      message: e?.message ?? "unknown",
    });
    return { available: false, linked: null, pending: null };
  }
}

/**
 * @param {{
 *   coveragePct: number;
 *   pending: number;
 *   stalePct: number;
 *   ordersAvailable: boolean;
 * }} p
 */
function resolveHealthStatus(p) {
  if (!p.ordersAvailable) return INGESTION_HEALTH_STATUS.UNKNOWN;

  if (
    p.coveragePct < COVERAGE_DEGRADED_PCT ||
    p.pending > PENDING_CRITICAL_COUNT ||
    p.stalePct > STALE_CRITICAL_PCT
  ) {
    return INGESTION_HEALTH_STATUS.CRITICAL;
  }

  if (
    p.pending > 0 ||
    p.coveragePct < COVERAGE_HEALTHY_PCT ||
    p.stalePct > STALE_DEGRADED_PCT
  ) {
    return INGESTION_HEALTH_STATUS.DEGRADED;
  }

  return INGESTION_HEALTH_STATUS.HEALTHY;
}

/**
 * @param {{
 *   status: string;
 *   coveragePct: number;
 *   pending: number;
 *   stalePct: number;
 *   globalAvailable: boolean;
 *   globalLinked: number | null;
 *   materializedCustomers: number;
 * }} p
 * @returns {string[]}
 */
function buildSignals(p) {
  /** @type {string[]} */
  const signals = [];

  if (p.pending === 0) signals.push("pending_orders_zero");
  else signals.push("pending_orders_present");

  if (p.coveragePct >= COVERAGE_HEALTHY_PCT) signals.push("coverage_above_threshold");
  else if (p.coveragePct >= COVERAGE_DEGRADED_PCT) signals.push("coverage_below_healthy");
  else signals.push("coverage_below_threshold");

  if (p.stalePct > STALE_DEGRADED_PCT) signals.push("stale_elevated");

  if (!p.globalAvailable) {
    signals.push("global_unavailable");
  } else if (p.globalLinked != null && p.materializedCustomers > 0 && p.globalLinked < p.materializedCustomers) {
    signals.push("global_sync_partial");
  } else if (p.globalLinked != null && p.globalLinked > 0) {
    signals.push("global_sync_ok");
  }

  if (p.status === INGESTION_HEALTH_STATUS.HEALTHY) signals.push("pipeline_healthy");

  return signals;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 */
export async function computeIngestionHealthCounts(supabase, scope) {
  const [orders, customers, global] = await Promise.all([
    countOrdersMetrics(supabase, scope),
    countMaterializedCustomers(supabase, scope),
    countGlobalSyncMetrics(supabase, scope),
  ]);

  const materializedCustomers = customers.available ? customers.count : 0;
  const totalWithBuyer = orders.totalWithBuyer;
  const pendingMaterialization = orders.pending;
  const materializedOrders = orders.materialized;

  const coveragePct =
    orders.available && totalWithBuyer > 0
      ? Math.round((materializedOrders / totalWithBuyer) * 1000) / 10
      : orders.available
        ? 100
        : 0;

  const globalLinked = global.available ? global.linked : null;
  const pendingGlobalSync =
    global.available && globalLinked != null
      ? Math.max(0, materializedCustomers - globalLinked)
      : null;

  return {
    orders,
    customers,
    global,
    materializedCustomers,
    totalWithBuyer,
    pendingMaterialization,
    materializedOrders,
    coveragePct,
    globalLinked,
    pendingGlobalSync,
  };
}

/**
 * @param {Awaited<ReturnType<typeof computeIngestionHealthCounts>>} counts
 * @param {number} stale
 */
export function finalizeIngestionHealthSnapshot(counts, stale) {
  const stalePct =
    counts.materializedCustomers > 0
      ? Math.round((stale / counts.materializedCustomers) * 1000) / 10
      : 0;

  const status = resolveHealthStatus({
    coveragePct: counts.coveragePct,
    pending: counts.pendingMaterialization,
    stalePct,
    ordersAvailable: counts.orders.available,
  });

  return {
    status,
    computed_at: new Date().toISOString(),
    coverage_pct: counts.coveragePct,
    orders: {
      total_with_buyer: counts.totalWithBuyer,
      materialized: counts.materializedOrders,
      pending_materialization: counts.pendingMaterialization,
    },
    customers: {
      materialized: counts.materializedCustomers,
      stale,
    },
    global: {
      linked: counts.globalLinked,
      pending_global_sync: counts.pendingGlobalSync,
    },
    states: {
      pending_materialization: counts.pendingMaterialization,
      materialized: counts.materializedCustomers,
      global_synced: counts.globalLinked,
      stale,
    },
    signals: buildSignals({
      status,
      coveragePct: counts.coveragePct,
      pending: counts.pendingMaterialization,
      stalePct,
      globalAvailable: counts.global.available,
      globalLinked: counts.globalLinked,
      materializedCustomers: counts.materializedCustomers,
    }),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 * }} scope
 * @param {{
 *   customerRows?: Array<Record<string, unknown>>;
 *   aggregateMap?: Map<string, { last_purchase_at: string | null }>;
 * }} [options]
 */
export async function computeIngestionHealthForScope(supabase, scope, options = {}) {
  const startedAt = Date.now();

  const counts = await computeIngestionHealthCounts(supabase, scope);

  const customerRows = options.customerRows ?? [];
  const aggregateMap = options.aggregateMap ?? new Map();

  const stale =
    customerRows.length > 0 && aggregateMap.size > 0
      ? countStaleCustomers(customerRows, aggregateMap)
      : 0;

  const snapshot = finalizeIngestionHealthSnapshot(counts, stale);

  const durationMs = Date.now() - startedAt;
  console.info("[Suse7][customers-health]", {
    status: snapshot.status,
    duration_ms: durationMs,
    coverage_pct: snapshot.coverage_pct,
    pending: counts.pendingMaterialization,
    stale,
    global_available: counts.global.available,
  });

  return snapshot;
}
