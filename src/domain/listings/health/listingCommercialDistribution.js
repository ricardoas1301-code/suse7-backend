// ======================================================================
// Agregação por faixa — card Saúde comercial (Dashboard executivo).
// Margem histórica/lifetime via SSOT (profit/revenue totais, Decimal).
// Partição exaustiva: 1 listing = 1 bucket comercial.
// ======================================================================

import Decimal from "decimal.js";
import { LISTING_HEALTH_COMMERCIAL_DISTRIBUTION_BANDS } from "./listingHealthConstants.js";
import {
  montarContagemBucketsExclusiva,
  resolverChaveBucketComercialExclusivo,
  validarTotaisBuckets,
} from "./listingHealthBucketEngine.js";

/**
 * @param {unknown} raw
 * @returns {Decimal | null}
 */
function toDecimalOrNull(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const dec = new Decimal(String(raw).trim().replace(",", "."));
    return dec.isFinite() ? dec : null;
  } catch {
    return null;
  }
}

/**
 * Margem oficial derivada dos totais históricos do anúncio (não média de %).
 *
 * @param {{
 *   profit_margin_percent?: string | number | null;
 *   profit_brl?: string | number | null;
 *   gross_revenue_brl?: string | number | null;
 * }} snapshot
 * @returns {Decimal | null}
 */
export function resolverMargemHistoricaAnuncio(snapshot) {
  const marginFromField = toDecimalOrNull(snapshot.profit_margin_percent);
  if (marginFromField != null) return marginFromField;

  const profit = toDecimalOrNull(snapshot.profit_brl);
  const gross = toDecimalOrNull(snapshot.gross_revenue_brl);
  if (profit != null && gross != null && !gross.isZero()) {
    return profit.div(gross).mul(100);
  }
  return null;
}

/**
 * @param {Decimal} marginDec
 * @returns {string}
 */
export function resolverChaveFaixaMargemComercial(marginDec) {
  if (marginDec.isNegative()) return "negative_margin";
  if (marginDec.gte(30)) return "excellent_margin";
  if (marginDec.gte(20)) return "healthy_margin";
  if (marginDec.gte(10)) return "attention_margin";
  return "critical_margin";
}

/**
 * @param {{
 *   status_normalized?: string;
 *   sales_count?: number;
 * }} snapshot
 * @returns {boolean}
 */
export function anuncioAtivoSemVendaHistorica(snapshot) {
  if (snapshot.status_normalized !== "active") return false;
  const sales = Number(snapshot.sales_count ?? 0);
  return !Number.isFinite(sales) || sales <= 0;
}

/**
 * @param {{
 *   status_normalized?: string;
 *   sales_count?: number;
 * }} snapshot
 * @returns {boolean}
 */
export function anuncioAtivoComVendaHistorica(snapshot) {
  if (snapshot.status_normalized !== "active") return false;
  const sales = Number(snapshot.sales_count ?? 0);
  return Number.isFinite(sales) && sales > 0;
}

/**
 * Monta distribuição agregada por faixa de margem comercial (lifetime, exaustiva).
 *
 * @param {Array<{
 *   listing_id?: string;
 *   status_normalized?: string;
 *   sales_count?: number;
 *   profit_margin_percent?: string | number | null;
 *   profit_brl?: string | number | null;
 *   gross_revenue_brl?: string | number | null;
 * }>} snapshots
 */
export function montarDistribuicaoSaudeComercial(snapshots) {
  const items = snapshots.map((snapshot) => ({
    listing_id: snapshot.listing_id != null ? String(snapshot.listing_id) : "",
    snapshot,
  }));

  const { counts } = montarContagemBucketsExclusiva(
    items,
    resolverChaveBucketComercialExclusivo,
    LISTING_HEALTH_COMMERCIAL_DISTRIBUTION_BANDS,
  );

  let activeWithoutSalesCount = 0;
  let activeWithSalesCount = 0;
  let negativeProfitCount = 0;
  let criticalMarginBandCount = 0;

  for (const snapshot of snapshots) {
    if (anuncioAtivoSemVendaHistorica(snapshot)) activeWithoutSalesCount += 1;
    if (anuncioAtivoComVendaHistorica(snapshot)) activeWithSalesCount += 1;

    const bandKey = resolverChaveBucketComercialExclusivo(snapshot);
    if (bandKey === "negative_margin") negativeProfitCount += 1;
    if (bandKey === "critical_margin") criticalMarginBandCount += 1;
  }

  const distribution = LISTING_HEALTH_COMMERCIAL_DISTRIBUTION_BANDS.map((bandDef) => ({
    key: bandDef.key,
    label: bandDef.label,
    short_label: bandDef.short_label,
    severity: bandDef.severity,
    count: counts[bandDef.key] ?? 0,
    min_margin_percent:
      bandDef.key === "excellent_margin"
        ? "30"
        : bandDef.key === "healthy_margin"
          ? "20"
          : bandDef.key === "attention_margin"
            ? "10"
            : bandDef.key === "critical_margin"
              ? "0"
              : null,
    max_margin_percent:
      bandDef.key === "excellent_margin"
        ? null
        : bandDef.key === "healthy_margin"
          ? "29.99"
          : bandDef.key === "attention_margin"
            ? "19.99"
            : bandDef.key === "critical_margin"
              ? "9.99"
              : bandDef.key === "negative_margin"
                ? "-0.01"
                : null,
  }));

  const totalListings = snapshots.length;
  const validation = validarTotaisBuckets(totalListings, distribution, "comercial");

  return {
    total_listings: totalListings,
    scope: "lifetime",
    active_without_sales_count: activeWithoutSalesCount,
    active_with_sales_count: activeWithSalesCount,
    negative_profit_count: negativeProfitCount,
    critical_margin_count: criticalMarginBandCount,
    buckets_sum: validation.buckets_sum,
    unclassified_count: validation.unclassified_count,
    distribution,
  };
}

/** Payload vazio — fallback seguro. */
export function buildEmptyCommercialHealthDistribution() {
  return {
    title: "Saúde comercial",
    total_listings: 0,
    scope: "lifetime",
    active_without_sales_count: 0,
    active_with_sales_count: 0,
    negative_profit_count: 0,
    critical_margin_count: 0,
    buckets_sum: 0,
    unclassified_count: 0,
    distribution: LISTING_HEALTH_COMMERCIAL_DISTRIBUTION_BANDS.map((bandDef) => ({
      key: bandDef.key,
      label: bandDef.label,
      short_label: bandDef.short_label,
      severity: bandDef.severity,
      count: 0,
      min_margin_percent:
        bandDef.key === "excellent_margin"
          ? "30"
          : bandDef.key === "healthy_margin"
            ? "20"
            : bandDef.key === "attention_margin"
              ? "10"
              : bandDef.key === "critical_margin"
                ? "0"
                : null,
      max_margin_percent:
        bandDef.key === "excellent_margin"
          ? null
          : bandDef.key === "healthy_margin"
            ? "29.99"
            : bandDef.key === "attention_margin"
              ? "19.99"
              : bandDef.key === "critical_margin"
                ? "9.99"
                : bandDef.key === "negative_margin"
                  ? "-0.01"
                  : null,
    })),
  };
}
