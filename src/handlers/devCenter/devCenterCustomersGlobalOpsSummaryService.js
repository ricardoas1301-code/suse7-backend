// =============================================================================
// Dev Center 4A.5 — métricas operacionais admin global (cross-seller, LGPD-safe)
//
// Projeção read-only para GET /api/dev-center/customers-global → summary.
// Service role admin: NÃO filtra por user_id seller; NÃO expõe PII em logs.
// Reutiliza thresholds 4A.2/4A.3 via flags existentes, sem misturar escopo seller.
// =============================================================================

import { finalizeIngestionHealthSnapshot } from "../../services/customers/customerIngestionHealthService.js";
import { isCustomersIngestionHealthEnabled } from "../../services/customers/customerIngestionHealthConstants.js";
import {
  CONFIDENCE_FAIR_PCT,
  CONFIDENCE_GOOD_PCT,
  DATA_QUALITY_STATUS,
  isCustomersDataQualityEnabled,
} from "../../services/customers/customerDataQualityConstants.js";

const GLOBAL_QUALITY_SAMPLE_LIMIT = 5000;

function isMissingTableOrColumn(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("column");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function probeIngestionColumn(supabase) {
  const probe = await supabase.from("sales_orders").select("customer_ingested_at").limit(1);
  if (probe.error && isMissingTableOrColumn(probe.error)) return false;
  if (probe.error) throw probe.error;
  return true;
}

/**
 * Pedidos materializados vs pendentes — plataforma inteira (sem escopo seller).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function countGlobalOrdersIngestion(supabase) {
  const hasColumn = await probeIngestionColumn(supabase);
  if (!hasColumn) {
    return { available: false, totalWithBuyer: 0, materialized: 0, pending: 0 };
  }

  const [totalRes, pendingRes] = await Promise.all([
    supabase.from("sales_orders").select("id", { count: "exact", head: true }),
    supabase.from("sales_orders").select("id", { count: "exact", head: true }).is("customer_ingested_at", null),
  ]);

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
 */
async function countGlobalMaterializedCustomers(supabase) {
  const { count, error } = await supabase.from("marketplace_customers").select("id", { count: "exact", head: true });
  if (error) {
    if (isMissingTableOrColumn(error)) return { available: false, count: 0 };
    throw error;
  }
  return { available: true, count: Number(count ?? 0) || 0 };
}

/**
 * Chaves únicas em related_sellers — indicador de sync global cross-seller.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function countGlobalLinkedKeys(supabase) {
  const { data, error } = await supabase.from("s7_global_customers").select("related_sellers").limit(GLOBAL_QUALITY_SAMPLE_LIMIT);

  if (error) {
    if (isMissingTableOrColumn(error)) return { available: false, count: null, sampleCapped: false };
    throw error;
  }

  /** @type {Set<string>} */
  const linkedKeys = new Set();

  for (const row of data ?? []) {
    const sellers = Array.isArray(row.related_sellers) ? row.related_sellers : [];
    for (const entry of sellers) {
      if (!entry || typeof entry !== "object") continue;
      const ext = entry.external_customer_id != null ? String(entry.external_customer_id).trim() : "";
      if (!ext) continue;
      linkedKeys.add(
        `${String(entry.marketplace ?? "")}|${String(entry.marketplace_account_id ?? "")}|${String(entry.seller_company_id ?? "")}|${ext}`,
      );
    }
  }

  return {
    available: true,
    count: linkedKeys.size,
    sampleCapped: (data ?? []).length >= GLOBAL_QUALITY_SAMPLE_LIMIT,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function countGlobalTotalCustomers(supabase) {
  const { count, error } = await supabase.from("s7_global_customers").select("id", { count: "exact", head: true });
  if (error) {
    if (isMissingTableOrColumn(error)) return { available: false, count: 0 };
    throw error;
  }
  return { available: true, count: Number(count ?? 0) || 0 };
}

/**
 * Contato incompleto global — sem e-mail E sem telefone normalizados (LGPD-safe).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function countGlobalIncompleteContact(supabase) {
  const { count, error } = await supabase
    .from("s7_global_customers")
    .select("id", { count: "exact", head: true })
    .is("email_normalized", null)
    .is("phone_normalized", null);

  if (error) {
    if (isMissingTableOrColumn(error)) return { available: false, count: null };
    throw error;
  }
  return { available: true, count: Number(count ?? 0) || 0 };
}

/**
 * Amostra para qualidade global — apenas campos normalizados, sem PII bruta.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function loadGlobalQualitySample(supabase) {
  const { data, error } = await supabase
    .from("s7_global_customers")
    .select("id, email_normalized, phone_normalized, document_normalized, last_purchase_global, updated_at")
    .limit(GLOBAL_QUALITY_SAMPLE_LIMIT);

  if (error) {
    if (isMissingTableOrColumn(error)) return { available: false, rows: [], sampleCapped: false };
    throw error;
  }

  return {
    available: true,
    rows: data ?? [],
    sampleCapped: (data ?? []).length >= GLOBAL_QUALITY_SAMPLE_LIMIT,
  };
}

/**
 * Confiança simplificada para s7_global_customers (sem endereço — dimensão ausente na tabela global).
 * @param {Record<string, unknown>} row
 */
function scoreGlobalCustomerRow(row) {
  const hasEmail = Boolean(row.email_normalized);
  const hasPhone = Boolean(row.phone_normalized);
  const contactPct = (hasEmail ? 50 : 0) + (hasPhone ? 50 : 0);
  const identityPct = row.document_normalized ? 100 : 0;
  const recencyPct = row.last_purchase_global ? 80 : 0;

  return Math.round(contactPct * 0.4 + identityPct * 0.35 + recencyPct * 0.25);
}

/** @param {number} confidencePct */
function resolveQualityStatus(confidencePct) {
  if (confidencePct >= CONFIDENCE_GOOD_PCT) return DATA_QUALITY_STATUS.GOOD;
  if (confidencePct >= CONFIDENCE_FAIR_PCT) return DATA_QUALITY_STATUS.FAIR;
  return DATA_QUALITY_STATUS.POOR;
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {boolean} sampleCapped
 */
function computeGlobalDataQualityOverview(rows, sampleCapped) {
  if (!rows.length) {
    return {
      status: DATA_QUALITY_STATUS.UNKNOWN,
      confidence_pct: 0,
      computed_at: new Date().toISOString(),
      scope: "admin_global",
      sample_size: 0,
      sample_capped: false,
      signals: ["global_empty"],
    };
  }

  /** @type {number[]} */
  const confidences = [];
  let contactWeak = 0;
  let identityMissing = 0;
  let recencyGaps = 0;

  for (const row of rows) {
    const pct = scoreGlobalCustomerRow(row);
    confidences.push(pct);
    if (!row.email_normalized && !row.phone_normalized) contactWeak += 1;
    if (!row.document_normalized) identityMissing += 1;
    if (!row.last_purchase_global) recencyGaps += 1;
  }

  const confidence_pct =
    confidences.length > 0
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 10) / 10
      : 0;

  const status = resolveQualityStatus(confidence_pct);
  /** @type {string[]} */
  const signals = ["admin_global_aggregate"];
  if (sampleCapped) signals.push("global_sample_capped");
  if (contactWeak > rows.length * 0.2) signals.push("contact_coverage_low");
  if (identityMissing > rows.length * 0.25) signals.push("identity_gaps");
  if (recencyGaps > rows.length * 0.2) signals.push("recency_gaps");
  if (status === DATA_QUALITY_STATUS.GOOD) signals.push("data_quality_good");

  return {
    status,
    confidence_pct,
    computed_at: new Date().toISOString(),
    scope: "admin_global",
    sample_size: rows.length,
    sample_capped: sampleCapped,
    signals,
  };
}

/**
 * Summary operacional para listagem admin global.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ listedCount?: number; traceId?: string }} [options]
 */
export async function buildDevCenterCustomersGlobalSummary(supabase, options = {}) {
  const { listedCount = 0, traceId = "" } = options;
  const startedAt = Date.now();

  const [totalRes, incompleteRes, qualitySample] = await Promise.all([
    countGlobalTotalCustomers(supabase),
    countGlobalIncompleteContact(supabase),
    loadGlobalQualitySample(supabase),
  ]);

  /** @type {Record<string, unknown>} */
  const summary = {
    scope: "admin_global",
    total_customers: totalRes.available ? totalRes.count : listedCount,
    listed_customers: listedCount,
    incomplete_contact: incompleteRes.available ? incompleteRes.count : null,
    ingestion_health: null,
    data_quality_overview: null,
  };

  if (isCustomersIngestionHealthEnabled()) {
    try {
      const [orders, customers, globalLinked] = await Promise.all([
        countGlobalOrdersIngestion(supabase),
        countGlobalMaterializedCustomers(supabase),
        countGlobalLinkedKeys(supabase),
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
      const globalLinkedCount = globalLinked.available ? globalLinked.count : null;
      const pendingGlobalSync =
        globalLinked.available && globalLinkedCount != null
          ? Math.max(0, materializedCustomers - globalLinkedCount)
          : null;

      const counts = {
        orders,
        customers,
        global: {
          available: globalLinked.available,
          linked: globalLinkedCount,
          pending: null,
        },
        materializedCustomers,
        totalWithBuyer,
        pendingMaterialization,
        materializedOrders,
        coveragePct,
        globalLinked: globalLinkedCount,
        pendingGlobalSync,
      };

      const snapshot = finalizeIngestionHealthSnapshot(counts, 0);
      summary.ingestion_health = {
        ...snapshot,
        scope: "admin_global",
        signals: [
          ...(Array.isArray(snapshot.signals) ? snapshot.signals : []),
          "admin_global_aggregate",
          "stale_not_computed_global",
          ...(globalLinked.sampleCapped ? ["global_sync_sample_capped"] : []),
        ],
      };
    } catch (e) {
      console.warn("[dev-center-admin] global_ingestion_health_failed", {
        message: e?.message ?? String(e),
        traceId,
      });
    }
  }

  if (isCustomersDataQualityEnabled() && qualitySample.available) {
    summary.data_quality_overview = computeGlobalDataQualityOverview(qualitySample.rows, qualitySample.sampleCapped);
  }

  console.info("[dev-center-admin] customers_global_summary", {
    scope: "admin_global",
    total_customers: summary.total_customers,
    incomplete_contact: summary.incomplete_contact,
    ingestion_enabled: isCustomersIngestionHealthEnabled(),
    quality_enabled: isCustomersDataQualityEnabled(),
    duration_ms: Date.now() - startedAt,
    traceId,
  });

  return summary;
}
