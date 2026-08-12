// ======================================================================
// Proveniência financeira V2 — origem operacional, snapshot interno, ML.
// FIN.SSOT.PROVENANCE-V2.DEV.02
// ======================================================================

import { BILLING_SNAPSHOT_ORIGIN } from "../../billing/billingConstants.js";

/** @typedef {typeof INTERNAL_PROVENANCE_CLASS[keyof typeof INTERNAL_PROVENANCE_CLASS]} InternalProvenanceClass */
/** @typedef {typeof MARKETPLACE_PROVENANCE_CLASS[keyof typeof MARKETPLACE_PROVENANCE_CLASS]} MarketplaceProvenanceClass */

export const INTERNAL_PROVENANCE_CLASS = /** @type {const} */ ({
  CAPTURED_AT_INGESTION: "CAPTURED_AT_INGESTION",
  RECONSTRUCTED_EXACT: "RECONSTRUCTED_EXACT",
  RECONSTRUCTED_ESTIMATED: "RECONSTRUCTED_ESTIMATED",
  LEGACY_UNVERIFIED: "LEGACY_UNVERIFIED",
});

export const MARKETPLACE_PROVENANCE_CLASS = /** @type {const} */ ({
  MARKETPLACE_EXACT: "MARKETPLACE_EXACT",
  MARKETPLACE_PARTIAL: "MARKETPLACE_PARTIAL",
  UNKNOWN: "UNKNOWN",
});

/** Origens operacionais além do billing canônico. */
export const OPERATIONAL_ORIGIN_EXTENDED = /** @type {const} */ ({
  ...BILLING_SNAPSHOT_ORIGIN,
  MANUAL_BACKFILL: "manual_backfill",
  LAZY_DETAIL_ENRICHMENT: "lazy_detail_enrichment",
});

/** @param {unknown} v */
function pickTrim(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeOperationalOrigin(value) {
  const raw = pickTrim(value).toLowerCase();
  if (!raw) return OPERATIONAL_ORIGIN_EXTENDED.UNKNOWN;

  const allowed = new Set(Object.values(OPERATIONAL_ORIGIN_EXTENDED));
  if (allowed.has(/** @type {any} */ (raw))) return raw;

  if (raw === "post_suse7_sale") return OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK;
  if (raw === "onboarding_import") return OPERATIONAL_ORIGIN_EXTENDED.ONBOARDING_IMPORT;

  return OPERATIONAL_ORIGIN_EXTENDED.UNKNOWN;
}

/**
 * Compat legado — snapshot_origin para consumidores antigos.
 *
 * @param {string} operationalOrigin
 */
export function mapOperationalOriginToLegacySnapshotOrigin(operationalOrigin) {
  const normalized = normalizeOperationalOrigin(operationalOrigin);
  if (normalized === OPERATIONAL_ORIGIN_EXTENDED.ONBOARDING_IMPORT) {
    return "onboarding_import";
  }
  if (normalized === OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK) {
    return "post_suse7_sale";
  }
  return normalized;
}

/**
 * Mapping legado DEPRECATED — fonte canônica de confiança: internal_provenance_class.
 * snapshot_quality existe apenas para consumidores que ainda não migraram.
 */
export const LEGACY_SNAPSHOT_QUALITY_BY_INTERNAL_CLASS = Object.freeze({
  [INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION]: "historical",
  [INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_EXACT]: "historical",
  [INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED]: "reconstructed",
});

/**
 * Matriz de congelamento V2 — generic enrichment NÃO recalcula fotografia persistida.
 *
 * | internal_provenance_class   | frozen após persist | generic enrichment recalcula internos |
 * |-----------------------------|---------------------|---------------------------------------|
 * | CAPTURED_AT_INGESTION       | SIM                 | NÃO                                   |
 * | RECONSTRUCTED_EXACT         | SIM                 | NÃO                                   |
 * | RECONSTRUCTED_ESTIMATED     | SIM (immutable)     | NÃO                                   |
 * | LEGACY_UNVERIFIED + snapshot| SIM (regra .01)     | NÃO                                   |
 */
export const INTERNAL_PROVENANCE_FREEZE_MATRIX = Object.freeze({
  [INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION]: {
    frozen_after_persist: true,
    generic_enrichment_may_recalc_internal: false,
  },
  [INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_EXACT]: {
    frozen_after_persist: true,
    generic_enrichment_may_recalc_internal: false,
  },
  [INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED]: {
    frozen_after_persist: true,
    generic_enrichment_may_recalc_internal: false,
  },
  [INTERNAL_PROVENANCE_CLASS.LEGACY_UNVERIFIED]: {
    frozen_after_persist: "when_immutable_marker_and_internal_subsnapshots",
    generic_enrichment_may_recalc_internal: false,
  },
});

/**
 * Promoção ESTIMATED → EXACT — somente por writer dedicado (não generic enrichment).
 *
 * Contrato futuro:
 * - writer explícito (ex.: historical_reconstruction_writer)
 * - evidência histórica versionada em provenance_sources
 * - auditoria before/after
 * - reconstruction_exact=true
 * Generic enrichment NUNCA promove classe.
 */
export const ESTIMATED_TO_EXACT_PROMOTION_CONTRACT = Object.freeze({
  allowed_by: "dedicated_historical_writer_only",
  forbidden_by: ["generic_enrichment", "lazy_detail", "reconciliation_auto", "backfill_default"],
  required_fields: [
    "internal_provenance_class",
    "provenance_sources",
    "reconstructed_at",
    "reconstruction_reference_date",
  ],
});

/**
 * Compat legado — snapshot_quality derivado da classe interna V2.
 *
 * @param {InternalProvenanceClass | string | null | undefined} internalClass
 */
export function mapInternalProvenanceToLegacySnapshotQuality(internalClass) {
  const cls = pickTrim(internalClass);
  if (cls in LEGACY_SNAPSHOT_QUALITY_BY_INTERNAL_CLASS) {
    return LEGACY_SNAPSHOT_QUALITY_BY_INTERNAL_CLASS[/** @type {keyof typeof LEGACY_SNAPSHOT_QUALITY_BY_INTERNAL_CLASS} */ (cls)];
  }
  return null;
}

/**
 * Leitura — rows sem campo V2 classificam como LEGACY_UNVERIFIED (sem write).
 *
 * @param {Record<string, unknown> | null | undefined} fin
 * @returns {InternalProvenanceClass}
 */
export function resolveInternalProvenanceClassForRead(fin) {
  const stored = pickTrim(fin?.internal_provenance_class);
  const allowed = new Set(Object.values(INTERNAL_PROVENANCE_CLASS));
  if (stored && allowed.has(/** @type {any} */ (stored))) {
    return /** @type {InternalProvenanceClass} */ (stored);
  }
  return INTERNAL_PROVENANCE_CLASS.LEGACY_UNVERIFIED;
}

/**
 * @param {unknown} saleCreatedAt
 * @param {unknown} capturedAt
 * @returns {number | null}
 */
export function computeCaptureLagSeconds(saleCreatedAt, capturedAt) {
  const saleRaw = pickTrim(saleCreatedAt);
  const capRaw = pickTrim(capturedAt);
  if (!saleRaw || !capRaw) return null;
  const saleMs = Date.parse(saleRaw);
  const capMs = Date.parse(capRaw);
  if (!Number.isFinite(saleMs) || !Number.isFinite(capMs)) return null;
  return Math.max(0, Math.round((capMs - saleMs) / 1000));
}

/**
 * @param {Record<string, unknown> | null | undefined} fin
 */
function hasInternalSubSnapshots(fin) {
  if (!fin || typeof fin !== "object") return false;
  return (
    (fin.internal_costs_snapshot && typeof fin.internal_costs_snapshot === "object") ||
    (fin.tax_snapshot && typeof fin.tax_snapshot === "object") ||
    (fin.product_cost_snapshot && typeof fin.product_cost_snapshot === "object")
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} existing
 */
export function hasEstablishedInternalProvenance(existing) {
  if (!existing || typeof existing !== "object") return false;

  const internalClass = pickTrim(existing.internal_provenance_class);
  if (internalClass) {
    return Boolean(
      pickTrim(existing.immutable_since) ||
        pickTrim(existing.snapshot_created_at) ||
        pickTrim(existing.captured_at),
    );
  }

  if (existing.snapshot_quality === "reconstructed" || existing.snapshot_origin === "onboarding_import") {
    return false;
  }

  if (!hasInternalSubSnapshots(existing)) return false;

  return Boolean(pickTrim(existing.immutable_since) || pickTrim(existing.snapshot_created_at));
}

/**
 * @param {Record<string, unknown>} existing
 */
function buildPreservedProvenanceMetadataFromExisting(existing) {
  const operationalOrigin =
    pickTrim(existing.operational_origin) ||
    normalizeOperationalOrigin(existing.snapshot_origin) ||
    OPERATIONAL_ORIGIN_EXTENDED.UNKNOWN;

  const legacyQuality =
    pickTrim(existing.snapshot_quality) ||
    (pickTrim(existing.internal_provenance_class)
      ? mapInternalProvenanceToLegacySnapshotQuality(existing.internal_provenance_class)
      : null);

  return {
    operational_origin: operationalOrigin,
    snapshot_origin: pickTrim(existing.snapshot_origin) || mapOperationalOriginToLegacySnapshotOrigin(operationalOrigin),
    internal_provenance_class: pickTrim(existing.internal_provenance_class) || null,
    marketplace_provenance_class: pickTrim(existing.marketplace_provenance_class) || null,
    snapshot_quality: legacyQuality,
    estimated: typeof existing.estimated === "boolean" ? existing.estimated : false,
    reconstructed_at: existing.reconstructed_at ?? null,
    reconstruction_reference_date: existing.reconstruction_reference_date ?? null,
    snapshot_created_at: existing.snapshot_created_at ?? null,
    immutable_since: existing.immutable_since ?? null,
    sale_created_at: existing.sale_created_at ?? null,
    captured_at: existing.captured_at ?? null,
    capture_lag_seconds:
      existing.capture_lag_seconds != null
        ? Number(existing.capture_lag_seconds)
        : computeCaptureLagSeconds(existing.sale_created_at, existing.captured_at),
    provenance_sources: existing.provenance_sources ?? null,
  };
}

/**
 * @param {{ snapshot_complete?: boolean }} [revenue]
 * @returns {MarketplaceProvenanceClass}
 */
export function resolveMarketplaceProvenanceClass(revenue = {}) {
  if (revenue.snapshot_complete === true) {
    return MARKETPLACE_PROVENANCE_CLASS.MARKETPLACE_EXACT;
  }
  const gross = pickTrim(revenue?.gross_sale_amount_brl);
  const fee = pickTrim(revenue?.marketplace_fee_amount_brl);
  if (gross || fee) {
    return MARKETPLACE_PROVENANCE_CLASS.MARKETPLACE_PARTIAL;
  }
  return MARKETPLACE_PROVENANCE_CLASS.UNKNOWN;
}

/**
 * Resolve metadata de proveniência V2 para persistência.
 *
 * @param {{
 *   operational_origin?: string | null;
 *   snapshot_origin?: string | null;
 *   is_initial_canonical_persist?: boolean;
 *   sale_created_at?: string | null;
 *   reconstruction_reference_date?: string | null;
 *   reconstruction_exact?: boolean;
 *   provenance_sources?: unknown[] | null;
 *   marketplace_snapshot_complete?: boolean;
 * }} ctx
 * @param {Record<string, unknown> | null | undefined} existing
 * @param {string} nowIso
 */
export function resolveFinancialSnapshotProvenanceV2(ctx, existing, nowIso) {
  if (hasEstablishedInternalProvenance(existing)) {
    return buildPreservedProvenanceMetadataFromExisting(/** @type {Record<string, unknown>} */ (existing));
  }

  const operationalOrigin = normalizeOperationalOrigin(ctx.operational_origin ?? ctx.snapshot_origin);
  const legacySnapshotOrigin = mapOperationalOriginToLegacySnapshotOrigin(operationalOrigin);
  const saleCreatedAt = pickTrim(ctx.sale_created_at) || null;
  const capturedAt = nowIso;
  const captureLagSeconds = computeCaptureLagSeconds(saleCreatedAt, capturedAt);
  const reconstructionReferenceDate =
    pickTrim(ctx.reconstruction_reference_date) || saleCreatedAt || nowIso;

  const marketplaceClass = ctx.marketplace_snapshot_complete
    ? MARKETPLACE_PROVENANCE_CLASS.MARKETPLACE_EXACT
    : MARKETPLACE_PROVENANCE_CLASS.UNKNOWN;

  const reconstructionExact =
    ctx.reconstruction_exact === true &&
    Array.isArray(ctx.provenance_sources) &&
    ctx.provenance_sources.length > 0;

  if (reconstructionExact) {
    return {
      operational_origin: operationalOrigin,
      snapshot_origin: legacySnapshotOrigin,
      internal_provenance_class: INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_EXACT,
      marketplace_provenance_class: marketplaceClass,
      snapshot_quality: mapInternalProvenanceToLegacySnapshotQuality(
        INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_EXACT,
      ),
      estimated: false,
      reconstructed_at: nowIso,
      reconstruction_reference_date: reconstructionReferenceDate,
      snapshot_created_at: null,
      immutable_since: pickTrim(existing?.immutable_since) || nowIso,
      sale_created_at: saleCreatedAt,
      captured_at: capturedAt,
      capture_lag_seconds: captureLagSeconds,
      provenance_sources: ctx.provenance_sources,
    };
  }

  if (operationalOrigin === OPERATIONAL_ORIGIN_EXTENDED.ONBOARDING_IMPORT) {
    return {
      operational_origin: operationalOrigin,
      snapshot_origin: "onboarding_import",
      internal_provenance_class: INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED,
      marketplace_provenance_class: marketplaceClass,
      snapshot_quality: "reconstructed",
      estimated: true,
      reconstructed_at: pickTrim(existing?.reconstructed_at) || nowIso,
      reconstruction_reference_date: reconstructionReferenceDate,
      snapshot_created_at: null,
      immutable_since: pickTrim(existing?.immutable_since) || nowIso,
      sale_created_at: saleCreatedAt,
      captured_at: capturedAt,
      capture_lag_seconds: captureLagSeconds,
      provenance_sources: ctx.provenance_sources ?? ["onboarding_import_current_config"],
    };
  }

  if (ctx.is_initial_canonical_persist === true) {
    return {
      operational_origin: operationalOrigin,
      snapshot_origin: legacySnapshotOrigin,
      internal_provenance_class: INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION,
      marketplace_provenance_class: marketplaceClass,
      snapshot_quality: mapInternalProvenanceToLegacySnapshotQuality(
        INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION,
      ),
      estimated: false,
      reconstructed_at: null,
      reconstruction_reference_date: null,
      snapshot_created_at: pickTrim(existing?.snapshot_created_at) || nowIso,
      immutable_since: pickTrim(existing?.immutable_since) || nowIso,
      sale_created_at: saleCreatedAt,
      captured_at: capturedAt,
      capture_lag_seconds: captureLagSeconds,
      provenance_sources: ctx.provenance_sources ?? null,
    };
  }

  return {
    operational_origin: operationalOrigin,
    snapshot_origin: legacySnapshotOrigin,
    internal_provenance_class: INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED,
    marketplace_provenance_class: marketplaceClass,
    snapshot_quality: mapInternalProvenanceToLegacySnapshotQuality(
      INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED,
    ),
    estimated: true,
    reconstructed_at: nowIso,
    reconstruction_reference_date: reconstructionReferenceDate,
    snapshot_created_at: null,
    immutable_since: pickTrim(existing?.immutable_since) || nowIso,
    sale_created_at: saleCreatedAt,
    captured_at: capturedAt,
    capture_lag_seconds: captureLagSeconds,
    provenance_sources:
      ctx.provenance_sources ??
      (operationalOrigin === OPERATIONAL_ORIGIN_EXTENDED.MANUAL_BACKFILL
        ? ["manual_backfill_current_config"]
        : ["current_seller_product_config"]),
  };
}
