// ======================================================================
// Helpers de preço — Central de Saúde da Concorrência (Decimal, sem float).
// Paridade com concorrenciaCompetitorDisplay.js / competitionListingStatus.js
// ======================================================================

import Decimal from "decimal.js";
import { isMercadoLivreListingActive } from "../competitionListingStatus.js";
import {
  COMPETITION_HEALTH_MONITORING_LIMIT,
  COMPETITION_HEALTH_PRICE_TOLERANCE_PCT,
  COMPETITION_HEALTH_RISK_HIGH_PCT,
  COMPETITION_HEALTH_RISK_MODERATE_PCT,
} from "./competitionHealthConstants.js";
import {
  formatDecimalFixed,
  toDecimalOrNull,
} from "../../products/health/productHealthNumericHelpers.js";

/** @param {unknown} competitor */
export function extrairPrecoConcorrente(competitor) {
  if (!competitor || typeof competitor !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (competitor);
  for (const key of ["last_seen_price", "competitor_price", "price"]) {
    const dec = toDecimalOrNull(record[key]);
    if (dec != null && dec.gt(0)) return dec;
  }
  return null;
}

/** @param {unknown} ownListing */
export function extrairPrecoProprio(ownListing) {
  if (!ownListing || typeof ownListing !== "object") return null;
  return toDecimalOrNull(/** @type {Record<string, unknown>} */ (ownListing).price);
}

/** @param {unknown} competitor */
export function isConcorrenteAtivoComparavel(competitor) {
  if (!competitor || typeof competitor !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (competitor);
  if (record.is_active === false) return false;
  if (record.is_competitor_listing_active === false) return false;

  const status =
    record.competitor_listing_status != null
      ? String(record.competitor_listing_status).trim()
      : record.listing_status != null
        ? String(record.listing_status).trim()
        : null;

  return isMercadoLivreListingActive(status);
}

/**
 * @param {readonly unknown[]} competitors
 * @returns {Array<{ competitor: Record<string, unknown>; price: Decimal }>}
 */
export function filtrarConcorrentesAtivosComPreco(competitors) {
  const list = Array.isArray(competitors) ? competitors : [];
  /** @type {Array<{ competitor: Record<string, unknown>; price: Decimal }>} */
  const rows = [];

  for (const competitor of list) {
    if (!isConcorrenteAtivoComparavel(competitor)) continue;
    const price = extrairPrecoConcorrente(competitor);
    if (price == null) continue;
    rows.push({
      competitor: /** @type {Record<string, unknown>} */ (competitor),
      price,
    });
  }

  return rows;
}

/** @param {readonly unknown[]} competitors */
export function resolverConcorrenteMaisBarato(competitors) {
  const priced = filtrarConcorrentesAtivosComPreco(competitors);
  if (!priced.length) return null;

  return priced.reduce((min, row) => (row.price.lt(min.price) ? row : min), priced[0]);
}

/** @param {readonly unknown[]} competitors */
export function resolverMenorPrecoConcorrente(competitors) {
  const row = resolverConcorrenteMaisBarato(competitors);
  return row?.price ?? null;
}

/**
 * @param {unknown} ownListing
 * @param {readonly unknown[]} competitors
 */
export function temConcorrenteAbaixoDoPreco(ownListing, competitors) {
  const nosso = extrairPrecoProprio(ownListing);
  if (nosso == null || !nosso.gt(0)) return false;
  return filtrarConcorrentesAtivosComPreco(competitors).some((row) => row.price.lt(nosso));
}

/**
 * @param {unknown} ownListing
 * @param {readonly unknown[]} competitors
 * @returns {"cheaper" | "competitive" | "more_expensive" | "no_comparison"}
 */
export function resolverChavePosicaoPreco(ownListing, competitors) {
  const ourPrice = extrairPrecoProprio(ownListing);
  const minCompetitor = resolverMenorPrecoConcorrente(competitors);
  if (ourPrice == null || !ourPrice.gt(0) || minCompetitor == null) return "no_comparison";

  if (ourPrice.lt(minCompetitor)) return "cheaper";

  const toleranceFactor = new Decimal(1).plus(
    new Decimal(COMPETITION_HEALTH_PRICE_TOLERANCE_PCT).div(100),
  );
  const competitiveCeiling = minCompetitor.mul(toleranceFactor);
  if (ourPrice.lte(competitiveCeiling)) return "competitive";
  return "more_expensive";
}

/**
 * @param {unknown} ownListing
 * @param {readonly unknown[]} competitors
 * @returns {"high_risk" | "moderate_risk" | "competitive" | "no_data"}
 */
export function resolverChaveRiscoCompetitivo(ownListing, competitors) {
  const ourPrice = extrairPrecoProprio(ownListing);
  const minCompetitor = resolverMenorPrecoConcorrente(competitors);
  if (ourPrice == null || !ourPrice.gt(0) || minCompetitor == null) return "no_data";

  if (ourPrice.lte(minCompetitor)) return "competitive";

  const diffRatio = ourPrice.minus(minCompetitor).div(ourPrice);
  const moderateThreshold = new Decimal(COMPETITION_HEALTH_RISK_MODERATE_PCT).div(100);
  const highThreshold = new Decimal(COMPETITION_HEALTH_RISK_HIGH_PCT).div(100);

  if (diffRatio.gte(highThreshold)) return "high_risk";
  if (diffRatio.gte(moderateThreshold)) return "moderate_risk";
  return "competitive";
}

/** @param {number | null | undefined} competitorsCount */
export function resolverChaveCoberturaMonitoramento(competitorsCount) {
  const count = Math.max(0, Math.trunc(Number(competitorsCount) || 0));
  if (count === 0) return "no_competitors";
  if (count >= COMPETITION_HEALTH_MONITORING_LIMIT) return "complete_monitoring";
  return "incomplete_monitoring";
}

/** @param {unknown} ownListing @param {readonly unknown[]} competitors */
export function snapshotTemComparacaoValida(ownListing, competitors) {
  return resolverChavePosicaoPreco(ownListing, competitors) !== "no_comparison";
}

/** @param {unknown} ownListing @param {readonly unknown[]} competitors */
export function snapshotTemBaseRiscoValida(ownListing, competitors) {
  return resolverChaveRiscoCompetitivo(ownListing, competitors) !== "no_data";
}

/**
 * @param {Array<Record<string, unknown>>} snapshots
 */
export function filtrarSnapshotsComComparacaoValida(snapshots) {
  return snapshots.filter((snapshot) =>
    snapshotTemComparacaoValida(snapshot.own_listing, snapshot.competitors),
  );
}

/**
 * @param {Array<Record<string, unknown>>} snapshots
 */
export function filtrarSnapshotsComBaseRiscoValida(snapshots) {
  return snapshots.filter((snapshot) =>
    snapshotTemBaseRiscoValida(snapshot.own_listing, snapshot.competitors),
  );
}

/** @param {Decimal} value */
export function formatDisplayValueBrl(value) {
  const fixed = formatDecimalFixed(value, 2);
  const [intPart, decPart] = fixed.split(".");
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${intFormatted},${decPart}`;
}

/**
 * Maior gap positivo (meu preço − menor concorrente) entre anúncios com comparação válida.
 * @param {Array<Record<string, unknown>>} snapshots
 */
export function calcularMaiorPressaoPreco(snapshots) {
  const comparisonSnapshots = filtrarSnapshotsComComparacaoValida(snapshots);

  /** @type {Decimal | null} */
  let maxGap = null;
  /** @type {Record<string, unknown> | null} */
  let bestSnapshot = null;
  /** @type {Record<string, unknown> | null} */
  let bestCompetitor = null;
  /** @type {Decimal | null} */
  let myPrice = null;
  /** @type {Decimal | null} */
  let competitorPrice = null;

  for (const snapshot of comparisonSnapshots) {
    const ourPrice = extrairPrecoProprio(snapshot.own_listing);
    const cheapest = resolverConcorrenteMaisBarato(snapshot.competitors);
    if (ourPrice == null || !ourPrice.gt(0) || cheapest == null) continue;
    if (ourPrice.lte(cheapest.price)) continue;

    const gap = ourPrice.minus(cheapest.price);
    if (maxGap == null || gap.gt(maxGap)) {
      maxGap = gap;
      bestSnapshot = snapshot;
      bestCompetitor = cheapest.competitor;
      myPrice = ourPrice;
      competitorPrice = cheapest.price;
    }
  }

  if (maxGap == null || !maxGap.gt(0)) {
    return {
      has_value: false,
      amount_brl: null,
      display_value: null,
      subtitle: "Nenhum concorrente abaixo do seu preço",
      marketplace_listing_id: null,
      competitor_id: null,
      competitor_listing_id: null,
      sku: null,
      my_price_brl: null,
      competitor_price_brl: null,
    };
  }

  return {
    has_value: true,
    amount_brl: formatDecimalFixed(maxGap, 2),
    display_value: formatDisplayValueBrl(maxGap),
    subtitle: "Maior diferença de concorrente mais barato",
    marketplace_listing_id: bestSnapshot?.marketplace_listing_id ?? null,
    competitor_id: bestCompetitor?.id ?? null,
    competitor_listing_id: bestCompetitor?.competitor_listing_id ?? null,
    sku: bestSnapshot?.sku ?? null,
    my_price_brl: myPrice != null ? formatDecimalFixed(myPrice, 2) : null,
    competitor_price_brl: competitorPrice != null ? formatDecimalFixed(competitorPrice, 2) : null,
  };
}
