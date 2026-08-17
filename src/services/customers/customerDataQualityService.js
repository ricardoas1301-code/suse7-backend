// =============================================================================
// Clientes 360 — qualidade de dados read-only (Fase 4A.3)
// Mede confiança dos dados — não score comercial, sem persistência, sem PII em logs.
// =============================================================================

import { customerAggregateKey } from "./customerOrderAggregateService.js";
import { extractPresentationFromCustomerRow } from "./customerPresentationMapper.js";
import {
  CONFIDENCE_FAIR_PCT,
  CONFIDENCE_GOOD_PCT,
  DATA_QUALITY_STATUS,
  DIMENSION_WEIGHTS,
  MAX_SAMPLE_ISSUES,
  RECENCY_COMPARE_TOLERANCE_MS,
  RECENCY_FRESH_DAYS,
} from "./customerDataQualityConstants.js";

function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normalizeEmail(v) {
  const s = safeStr(v)?.toLowerCase();
  if (!s || !s.includes("@")) return null;
  return s;
}

/**
 * @param {Array<Record<string, unknown>>} dbRows
 */
function buildDuplicateIndex(dbRows) {
  /** @type {Map<string, Set<string>>} */
  const byEmail = new Map();
  /** @type {Map<string, Set<string>>} */
  const byDocument = new Map();

  for (const row of dbRows) {
    const ext = safeStr(row.external_customer_id) ?? String(row.id ?? "");
    const email = normalizeEmail(row.email);
    const pres = extractPresentationFromCustomerRow(row);
    const doc = safeStr(pres.document);

    if (email) {
      if (!byEmail.has(email)) byEmail.set(email, new Set());
      byEmail.get(email).add(ext);
    }
    if (doc) {
      if (!byDocument.has(doc)) byDocument.set(doc, new Set());
      byDocument.get(doc).add(ext);
    }
  }

  return { byEmail, byDocument };
}

/**
 * @param {Map<string, Set<string>>} index
 * @param {string | null} key
 */
function isSuspiciousDuplicate(index, key) {
  if (!key) return false;
  const set = index.get(key);
  return Boolean(set && set.size > 1);
}

/**
 * @param {Record<string, unknown>} row
 */
function scoreContact(row) {
  let score = 0;
  const email = safeStr(row.email);
  const phone = safeStr(row.phone);
  const whatsapp = safeStr(row.whatsapp) || safeStr(row.whatsapp_e164);
  if (email) score += Boolean(row.email_is_masked) ? 17 : 34;
  if (phone) score += 33;
  if (whatsapp) score += 33;
  return Math.min(100, score);
}

/**
 * @param {ReturnType<typeof extractPresentationFromCustomerRow>} pres
 */
function scoreAddress(pres) {
  const city = safeStr(pres.city);
  const state = safeStr(pres.state);
  const zip = safeStr(pres.address?.zip_code);
  let score = 0;
  if (city) score += 34;
  if (state) score += 33;
  if (zip) score += 33;
  return Math.min(100, score);
}

/**
 * @param {ReturnType<typeof extractPresentationFromCustomerRow>} pres
 * @param {{ emailDup: boolean; documentDup: boolean }} dup
 */
function scoreIdentity(pres, dup) {
  const document = safeStr(pres.document);
  if (!document) return 0;
  if (dup.documentDup || dup.emailDup) return 50;
  return 100;
}

/**
 * @param {Record<string, unknown>} row
 * @param {{ last_purchase_at: string | null }} agg
 */
function scoreRecency(row, agg) {
  let score = 0;
  const lastPurchase = safeStr(agg?.last_purchase_at);
  if (lastPurchase) score += 50;

  const updatedMs = Date.parse(String(row.updated_at ?? ""));
  const lastPurchaseMs = lastPurchase ? Date.parse(lastPurchase) : NaN;
  const now = Date.now();
  const freshWindowMs = RECENCY_FRESH_DAYS * 24 * 60 * 60 * 1000;

  if (Number.isFinite(updatedMs)) {
    if (Number.isFinite(lastPurchaseMs) && updatedMs + RECENCY_COMPARE_TOLERANCE_MS >= lastPurchaseMs) {
      score += 50;
    } else if (now - updatedMs <= freshWindowMs) {
      score += 30;
    }
  }

  return Math.min(100, score);
}

/**
 * @param {{
 *   contact: number;
 *   address: number;
 *   identity: number;
 *   recency: number;
 * }} dims
 */
function weightedConfidence(dims) {
  const w = DIMENSION_WEIGHTS;
  const raw =
    dims.contact * w.contact +
    dims.address * w.address +
    dims.identity * w.identity +
    dims.recency * w.recency;
  return Math.round(raw * 10) / 10;
}

/**
 * @param {number} confidencePct
 */
function resolveQualityStatus(confidencePct) {
  if (confidencePct >= CONFIDENCE_GOOD_PCT) return DATA_QUALITY_STATUS.GOOD;
  if (confidencePct >= CONFIDENCE_FAIR_PCT) return DATA_QUALITY_STATUS.FAIR;
  return DATA_QUALITY_STATUS.POOR;
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReturnType<typeof extractPresentationFromCustomerRow>} pres
 * @param {{ last_purchase_at: string | null }} agg
 * @param {{ byEmail: Map<string, Set<string>>; byDocument: Map<string, Set<string>> }} dupIndex
 */
function assessCustomerDataQuality(row, pres, agg, dupIndex) {
  const emailKey = normalizeEmail(row.email);
  const docKey = safeStr(pres.document);
  const dup = {
    emailDup: isSuspiciousDuplicate(dupIndex.byEmail, emailKey),
    documentDup: isSuspiciousDuplicate(dupIndex.byDocument, docKey),
  };

  const contactPct = scoreContact(row);
  const addressPct = scoreAddress(pres);
  const identityPct = scoreIdentity(pres, dup);
  const recencyPct = scoreRecency(row, agg);
  const confidence_pct = weightedConfidence({
    contact: contactPct,
    address: addressPct,
    identity: identityPct,
    recency: recencyPct,
  });

  /** @type {string[]} */
  const signals = [];
  if (contactPct >= 85) signals.push("contact_strong");
  else if (contactPct < 50) signals.push("contact_weak");

  if (addressPct >= 85) signals.push("address_complete");
  else if (addressPct < 50) signals.push("address_incomplete");

  if (!docKey) signals.push("identity_document_missing");
  else if (dup.documentDup || dup.emailDup) signals.push("identity_duplicate_suspected");

  if (recencyPct < 50) signals.push("recency_stale");

  /** @type {Array<{ code: string; dimension: string }>} */
  const sample_issues = [];
  if (!safeStr(row.email)) sample_issues.push({ code: "missing_email", dimension: "contact" });
  if (!safeStr(row.phone) && !safeStr(row.whatsapp) && !safeStr(row.whatsapp_e164)) {
    sample_issues.push({ code: "missing_phone", dimension: "contact" });
  }
  if (!safeStr(pres.city)) sample_issues.push({ code: "missing_city", dimension: "address" });
  if (!safeStr(pres.state)) sample_issues.push({ code: "missing_state", dimension: "address" });
  if (!safeStr(pres.address?.zip_code)) sample_issues.push({ code: "missing_zip_code", dimension: "address" });
  if (!docKey) sample_issues.push({ code: "missing_document", dimension: "identity" });
  if (dup.documentDup) sample_issues.push({ code: "suspicious_duplicate_document", dimension: "identity" });
  if (dup.emailDup) sample_issues.push({ code: "suspicious_duplicate_email", dimension: "identity" });
  if (!safeStr(agg?.last_purchase_at)) sample_issues.push({ code: "missing_last_purchase", dimension: "recency" });

  return {
    confidence_pct,
    status: resolveQualityStatus(confidence_pct),
    signals,
    sample_issues: sample_issues.slice(0, MAX_SAMPLE_ISSUES),
    dimensions: {
      contact: {
        confidence_pct: contactPct,
        email: Boolean(safeStr(row.email)),
        phone: Boolean(safeStr(row.phone)),
        whatsapp: Boolean(safeStr(row.whatsapp) || safeStr(row.whatsapp_e164)),
      },
      address: {
        confidence_pct: addressPct,
        city: Boolean(safeStr(pres.city)),
        state: Boolean(safeStr(pres.state)),
        zip_code: Boolean(safeStr(pres.address?.zip_code)),
      },
      identity: {
        confidence_pct: identityPct,
        document: Boolean(docKey),
        suspicious_duplicate: dup.documentDup || dup.emailDup,
      },
      recency: {
        confidence_pct: recencyPct,
        last_purchase_at: Boolean(safeStr(agg?.last_purchase_at)),
        updated_at_fresh: recencyPct >= 80,
      },
    },
  };
}

/**
 * @param {Array<Record<string, unknown>>} dbRows
 * @param {Map<string, { last_purchase_at: string | null }>} aggregateMap
 */
export function computeDataQualityOverviewFromRows(dbRows, aggregateMap) {
  const startedAt = Date.now();

  if (!dbRows.length) {
    return {
      status: DATA_QUALITY_STATUS.UNKNOWN,
      confidence_pct: 0,
      computed_at: new Date().toISOString(),
    };
  }

  const dupIndex = buildDuplicateIndex(dbRows);
  /** @type {number[]} */
  const confidences = [];
  /** @type {Map<string, number>} */
  const signalCounts = new Map();

  for (const row of dbRows) {
    const key = customerAggregateKey({
      marketplace: row.marketplace,
      marketplaceAccountId: row.marketplace_account_id,
      sellerCompanyId: row.seller_company_id,
      externalCustomerId: row.external_customer_id,
    });
    const agg = (key && aggregateMap.get(key)) || { last_purchase_at: null };
    const pres = extractPresentationFromCustomerRow(row);
    const assessed = assessCustomerDataQuality(row, pres, agg, dupIndex);
    confidences.push(assessed.confidence_pct);
    for (const s of assessed.signals) {
      signalCounts.set(s, (signalCounts.get(s) ?? 0) + 1);
    }
  }

  const confidence_pct =
    confidences.length > 0
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 10) / 10
      : 0;

  const status = resolveQualityStatus(confidence_pct);

  /** @type {string[]} */
  const signals = [];
  const contactWeak = signalCounts.get("contact_weak") ?? 0;
  const addressIncomplete = signalCounts.get("address_incomplete") ?? 0;
  const identityMissing = signalCounts.get("identity_document_missing") ?? 0;
  const dupSuspected = signalCounts.get("identity_duplicate_suspected") ?? 0;
  const recencyStale = signalCounts.get("recency_stale") ?? 0;

  if (status === DATA_QUALITY_STATUS.GOOD) signals.push("data_quality_good");
  if (contactWeak > dbRows.length * 0.2) signals.push("contact_coverage_low");
  if (addressIncomplete > dbRows.length * 0.3) signals.push("address_coverage_low");
  if (identityMissing > dbRows.length * 0.25) signals.push("identity_gaps");
  if (dupSuspected > 0) signals.push("suspicious_duplicates_present");
  if (recencyStale > dbRows.length * 0.2) signals.push("recency_gaps");

  const durationMs = Date.now() - startedAt;
  console.info("[Suse7][customers-data-quality]", {
    status,
    confidence_pct,
    customers: dbRows.length,
    duration_ms: durationMs,
  });

  return {
    status,
    confidence_pct,
    computed_at: new Date().toISOString(),
    signals,
  };
}

/**
 * Overview resumido para GET /api/customers (sem signals na listagem).
 * @param {Array<Record<string, unknown>>} dbRows
 * @param {Map<string, { last_purchase_at: string | null }>} aggregateMap
 */
export function computeDataQualityOverviewForList(dbRows, aggregateMap) {
  const full = computeDataQualityOverviewFromRows(dbRows, aggregateMap);
  return {
    status: full.status,
    confidence_pct: full.confidence_pct,
    computed_at: full.computed_at,
  };
}

/**
 * Detalhamento para GET /api/customers/:id (preparado para 4A.4).
 * @param {Record<string, unknown>} row
 * @param {{ last_purchase_at: string | null; first_purchase_at?: string | null }} agg
 * @param {Array<Record<string, unknown>>} [scopeRowsForDup]
 */
export function computeCustomerDataQualityDetail(row, agg, scopeRowsForDup) {
  const dupSource = scopeRowsForDup?.length ? scopeRowsForDup : [row];
  const dupIndex = buildDuplicateIndex(dupSource);
  const pres = extractPresentationFromCustomerRow(row);
  const assessed = assessCustomerDataQuality(row, pres, agg, dupIndex);

  return {
    status: assessed.status,
    confidence_pct: assessed.confidence_pct,
    computed_at: new Date().toISOString(),
    dimensions: assessed.dimensions,
    signals: assessed.signals,
    sample_issues: assessed.sample_issues,
  };
}
