// =============================================================================
// Dev Center S_4.7.1 — contrato detalhe global enriquecido (1 query, LGPD-safe)
//
// GET /api/dev-center/customers-global/:id
//   customer      → apresentação mascarada (compat UI atual)
//   overview      → agregados estáveis de s7_global_customers
//   activity      → related_sellers sanitizado + canais distintos
//   quality       → not_available (sem score por cliente)
//   ingestion     → not_available (sem health por cliente)
//   metadata      → escopo, origem, freshness heurística do registro global
// =============================================================================

const RECORD_STALE_LAG_MS = 24 * 60 * 60 * 1000;

/** @param {string | null | undefined} key */
function dedupeStrategyFromKey(key) {
  const k = String(key ?? "");
  if (k.startsWith("doc:")) return "document";
  if (k.startsWith("email:")) return "email";
  if (k.startsWith("phone:")) return "phone";
  if (k.startsWith("legacy:")) return "legacy";
  return "unknown";
}

/**
 * Referência externa marketplace — truncada (LGPD S_4.8.1).
 * @param {unknown} value
 */
function maskExternalRefForApi(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (s.length <= 8) return `${s.slice(0, 2)}••••`;
  return `${s.slice(0, 6)}…`;
}

/**
 * @param {unknown} entries
 */
function sanitizeRelatedSellers(entries) {
  if (!Array.isArray(entries)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = /** @type {Record<string, unknown>} */ (entry);
    out.push({
      user_id: e.user_id != null ? String(e.user_id) : null,
      marketplace: e.marketplace != null ? String(e.marketplace) : null,
      marketplace_account_id: e.marketplace_account_id != null ? String(e.marketplace_account_id) : null,
      seller_company_id: e.seller_company_id != null ? String(e.seller_company_id) : null,
      external_customer_id:
        e.external_customer_id != null ? maskExternalRefForApi(String(e.external_customer_id)) : null,
    });
  }
  return out;
}

/**
 * Heurística read-only: registro global desatualizado vs última compra global.
 * Não mede stale de marketplace_customers seller — apenas lag do agregado global.
 * @param {Record<string, unknown>} row
 */
function computeGlobalRecordSync(row) {
  const updatedMs = Date.parse(String(row.updated_at ?? ""));
  const lastPurchaseMs = row.last_purchase_global ? Date.parse(String(row.last_purchase_global)) : NaN;

  if (!Number.isFinite(updatedMs)) {
    return { stale: null, stale_reason: "updated_at_unavailable" };
  }
  if (!Number.isFinite(lastPurchaseMs)) {
    return { stale: false, stale_reason: null };
  }
  if (updatedMs + RECORD_STALE_LAG_MS < lastPurchaseMs) {
    const lagHours = Math.round((lastPurchaseMs - updatedMs) / (60 * 60 * 1000));
    return { stale: true, stale_reason: "global_record_older_than_last_purchase", lag_hours: lagHours };
  }
  return { stale: false, stale_reason: null, lag_hours: 0 };
}

/**
 * @param {Record<string, unknown>} row
 * @param {{
 *   maskDocumentForApi: (v: string | null | undefined) => string | null;
 *   maskEmailForApi: (v: string | null | undefined) => string | null;
 *   maskPhoneForApi: (v: string | null | undefined) => string | null;
 * }} masks
 */
export function buildDevCenterCustomersGlobalDetail(row, masks) {
  const relatedSellers = sanitizeRelatedSellers(row.related_sellers);
  const activeChannels = [...new Set(relatedSellers.map((e) => e.marketplace).filter(Boolean))];

  const customer = {
    id: String(row.id),
    name: row.name ?? null,
    document_masked: row.document_normalized ? masks.maskDocumentForApi(String(row.document_normalized)) : null,
    email_masked: row.email_normalized ? masks.maskEmailForApi(String(row.email_normalized)) : null,
    phone_masked: row.phone_normalized ? masks.maskPhoneForApi(String(row.phone_normalized)) : null,
    total_orders_global: row.total_orders_global ?? 0,
    total_spent_global: row.total_spent_global != null ? String(row.total_spent_global) : "0.00",
    total_sellers_related: row.total_sellers_related ?? 0,
    first_purchase_global: row.first_purchase_global ?? null,
    last_purchase_global: row.last_purchase_global ?? null,
    related_sellers: relatedSellers,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };

  const overview = {
    total_orders_global: customer.total_orders_global,
    total_spent_global: customer.total_spent_global,
    first_purchase_global: customer.first_purchase_global,
    last_purchase_global: customer.last_purchase_global,
    total_sellers_related: customer.total_sellers_related,
    contact: {
      has_email: Boolean(row.email_normalized),
      has_phone: Boolean(row.phone_normalized),
      incomplete: !row.email_normalized && !row.phone_normalized,
    },
  };

  const activity = {
    related_sellers_count: relatedSellers.length,
    active_channels: activeChannels,
    related_sellers: relatedSellers,
  };

  const quality = {
    status: "not_available",
    confidence_pct: null,
    reason: "per_customer_quality_not_computed",
    scope: "admin_global",
  };

  const ingestion = {
    status: "not_available",
    coverage_pct: null,
    reason: "per_customer_ingestion_not_computed",
    scope: "admin_global",
  };

  const sync = computeGlobalRecordSync(row);

  const metadata = {
    scope: "admin_global",
    source: "s7_global_customers",
    contract_version: "S_4.7.1",
    masked_fields: ["document", "email", "phone"],
    dedupe_strategy: dedupeStrategyFromKey(row.dedupe_key != null ? String(row.dedupe_key) : null),
    record_created_at: row.created_at ?? null,
    record_updated_at: row.updated_at ?? null,
    sync,
  };

  return { customer, overview, activity, quality, ingestion, metadata };
}
