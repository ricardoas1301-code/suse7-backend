// ======================================================================
// Preservação de snapshots financeiros históricos no UPSERT canônico.
// MARKETPLACE FACTS podem atualizar; SELLER HISTORICAL SNAPSHOTS congelam.
// ======================================================================

/** Chaves S7 em raw_json que não devem ser apagadas no reprocessamento ML. */
export const S7_PRESERVED_RAW_JSON_KEYS = Object.freeze([
  "_s7_financial",
  "_s7_shipment_snapshot",
]);

/** Colunas monetárias derivadas do enrichment — preservadas enquanto snapshot completo. */
export const S7_PRESERVED_ENRICHMENT_COLUMNS = Object.freeze([
  "fee_amount",
  "shipping_share_amount",
  "net_amount",
]);

/**
 * @param {unknown} fin
 * @returns {Record<string, unknown> | null}
 */
function toFinancialObject(fin) {
  return fin && typeof fin === "object" ? /** @type {Record<string, unknown>} */ (fin) : null;
}

/**
 * Snapshot histórico interno considerado congelado (seller config na venda).
 * Complementa isItemFinancialSnapshotComplete — exige sub-snapshots internos.
 *
 * @param {Record<string, unknown> | null | undefined} fin
 */
export function isSellerHistoricalFinancialSnapshotFrozen(fin) {
  const snap = toFinancialObject(fin);
  if (!snap) return false;

  if (snap.snapshot_quality === "reconstructed") return false;
  if (snap.snapshot_origin === "onboarding_import") return false;

  const hasInternal =
    toFinancialObject(snap.internal_costs_snapshot) != null ||
    toFinancialObject(snap.tax_snapshot) != null ||
    toFinancialObject(snap.product_cost_snapshot) != null;

  if (!hasInternal) return false;

  const immutableSince =
    snap.immutable_since != null ? String(snap.immutable_since).trim() : "";
  const createdAt =
    snap.snapshot_created_at != null ? String(snap.snapshot_created_at).trim() : "";

  return Boolean(immutableSince || createdAt);
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function extractExistingFinancialSnapshot(row) {
  const raw =
    row?.raw_json && typeof row.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (row.raw_json)
      : null;
  return toFinancialObject(raw?._s7_financial);
}

/**
 * Mescla linha canônica incoming com snapshot existente (idempotência / imutabilidade).
 *
 * @param {Record<string, unknown>} incomingRow
 * @param {Record<string, unknown> | null | undefined} existingRow
 * @param {{ isMarketplaceSnapshotComplete?: (fin: Record<string, unknown> | null | undefined) => boolean }} [options]
 * @returns {Record<string, unknown>}
 */
export function mergeIncomingSalesOrderItemWithExistingSnapshot(incomingRow, existingRow, options = {}) {
  if (!existingRow || typeof existingRow !== "object") {
    return incomingRow;
  }

  const isMarketplaceComplete =
    options.isMarketplaceSnapshotComplete ?? (() => false);

  const existingFin = extractExistingFinancialSnapshot(existingRow);
  const sellerHistoricalFrozen = isSellerHistoricalFinancialSnapshotFrozen(existingFin);
  const marketplaceComplete = isMarketplaceComplete(existingFin);
  const isReconstructedImport =
    existingFin?.snapshot_quality === "reconstructed" ||
    existingFin?.snapshot_origin === "onboarding_import";
  const shouldPreserve = sellerHistoricalFrozen || (marketplaceComplete && !isReconstructedImport);

  if (!shouldPreserve) {
    return incomingRow;
  }

  const incomingRaw =
    incomingRow.raw_json && typeof incomingRow.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...incomingRow.raw_json })
      : incomingRow.raw_json != null
        ? { value: incomingRow.raw_json }
        : {};

  const existingRaw =
    existingRow.raw_json && typeof existingRow.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (existingRow.raw_json)
      : null;

  /** @type {Record<string, unknown>} */
  const mergedRaw = { ...incomingRaw };

  if (existingRaw) {
    for (const key of S7_PRESERVED_RAW_JSON_KEYS) {
      if (existingRaw[key] != null) {
        mergedRaw[key] = existingRaw[key];
      }
    }
  }

  /** @type {Record<string, unknown>} */
  const merged = {
    ...incomingRow,
    raw_json: mergedRaw,
  };

  if (shouldPreserve) {
    for (const col of S7_PRESERVED_ENRICHMENT_COLUMNS) {
      const existingVal = existingRow[col];
      const existingPresent = existingVal != null && String(existingVal).trim() !== "";
      if (existingPresent) {
        merged[col] = existingVal;
      }
    }
  }

  return merged;
}
