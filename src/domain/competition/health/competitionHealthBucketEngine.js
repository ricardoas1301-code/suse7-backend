// ======================================================================
// Motor de buckets — Central de Saúde da Concorrência (Dashboard).
// Unidade: anúncio/listing do seller (marketplace_listings).
// ======================================================================

import Decimal from "decimal.js";
import {
  COMPETITION_HEALTH_MONITORING_BANDS,
  COMPETITION_HEALTH_MONITORING_LIMIT,
  COMPETITION_HEALTH_PRICE_BASE_LABEL,
  COMPETITION_HEALTH_PRICE_POSITION_BANDS,
  COMPETITION_HEALTH_REPUTATION_BANDS,
  COMPETITION_HEALTH_REPUTATION_BASE_LABEL,
} from "./competitionHealthConstants.js";
import {
  deduplicarConcorrentesAtivosAnalisaveis,
  isConcorrenteLogisticaFull,
  isFreteGratisConcorrente,
  listarConcorrentesInativosMonitorados,
  resolverChaveReputacaoConcorrente,
} from "./competitionHealthCompetitorHelpers.js";
import {
  calcularMaiorPressaoPreco,
  filtrarSnapshotsComComparacaoValida,
  resolverChaveCoberturaMonitoramento,
  resolverChavePosicaoPreco,
} from "./competitionHealthPriceHelpers.js";
import {
  formatDecimalFixed,
  formatPercentFromRatio,
  toDecimalOrZero,
} from "../../products/health/productHealthNumericHelpers.js";
import {
  somarBucketsDistribuicao,
  validarTotaisBuckets,
} from "../../listings/health/listingHealthBucketEngine.js";

const LOG_PREFIX = "[S7_COMPETITION_HEALTH_DASHBOARD]";

/** @param {string} label @param {Record<string, unknown>} [payload] */
export function logCompetitionHealthDashboard(label, payload = {}) {
  if (process.env.NODE_ENV === "production") return;
  console.info(`${LOG_PREFIX} ${label}`, payload);
}

/**
 * @param {ReadonlyArray<{ key: string; label: string; chart_color: string }>} bandDefs
 * @param {Record<string, number>} counts
 * @param {number} totalListings
 */
function montarLinhasDistribuicaoCobertura(bandDefs, counts, totalListings) {
  return bandDefs.map((bandDef) => {
    const count = counts[bandDef.key] ?? 0;
    const sharePercent = formatPercentFromRatio(
      new Decimal(count),
      new Decimal(totalListings > 0 ? totalListings : 0),
    );

    return {
      key: bandDef.key,
      label: bandDef.label,
      count,
      listings_count: count,
      share_percent: sharePercent,
      mix_share_percent: sharePercent,
      chart_color: bandDef.chart_color ?? null,
    };
  });
}

/**
 * @param {ReadonlyArray<{ key: string; label: string; chart_color: string }>} bandDefs
 * @param {Record<string, number>} counts
 * @param {number} baseCount
 * @param {"listings" | "competitors"} unit
 */
function montarLinhasDistribuicaoBase(bandDefs, counts, baseCount, unit = "listings") {
  return bandDefs.map((bandDef) => {
    const count = counts[bandDef.key] ?? 0;
    const sharePercent = formatPercentFromRatio(
      new Decimal(count),
      new Decimal(baseCount > 0 ? baseCount : 0),
    );

    return {
      key: bandDef.key,
      label: bandDef.label,
      count,
      listings_count: unit === "listings" ? count : undefined,
      competitors_count: unit === "competitors" ? count : undefined,
      share_percent: sharePercent,
      mix_share_percent: sharePercent,
      chart_color: bandDef.chart_color ?? null,
    };
  });
}

/**
 * @param {ReadonlyArray<{ key: string; label: string; chart_color: string }>} bandDefs
 * @param {Record<string, number>} counts
 * @param {number} denominator
 * @param {"listings" | "competitors"} unit
 */
function montarChartSegmentos(bandDefs, counts, denominator, unit = "listings") {
  const distribution = montarLinhasDistribuicaoBase(bandDefs, counts, denominator, unit);
  const segments = distribution
    .filter((row) => (row.count ?? 0) > 0)
    .map((row) => ({
      key: row.key,
      label: row.label,
      count: row.count,
      listings_count: row.listings_count,
      competitors_count: row.competitors_count,
      share_percent: row.share_percent,
      mix_share_percent: row.mix_share_percent,
      chart_color: row.chart_color,
    }));

  const mixSegmentsSum = segments.reduce(
    (sum, row) => sum.plus(toDecimalOrZero(row.mix_share_percent)),
    new Decimal(0),
  );

  return {
    distribution,
    chart: {
      segments,
      mix_segments_sum_percent: formatDecimalFixed(mixSegmentsSum),
    },
  };
}

/** @param {Array<Record<string, unknown>>} snapshots */
export function montarDistribuicaoCoberturaMonitoramento(snapshots) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(COMPETITION_HEALTH_MONITORING_BANDS.map((band) => [band.key, 0]));

  for (const snapshot of snapshots) {
    const bucketKey = resolverChaveCoberturaMonitoramento(snapshot.competitors_count);
    counts[bucketKey] = (counts[bucketKey] ?? 0) + 1;
  }

  const totalListings = snapshots.length;
  const distribution = montarLinhasDistribuicaoCobertura(
    COMPETITION_HEALTH_MONITORING_BANDS,
    counts,
    totalListings,
  );
  const segments = distribution
    .filter((row) => (row.count ?? 0) > 0)
    .map((row) => ({
      key: row.key,
      label: row.label,
      count: row.count,
      listings_count: row.listings_count,
      share_percent: row.share_percent,
      mix_share_percent: row.mix_share_percent,
      chart_color: row.chart_color,
    }));

  const mixSegmentsSum = segments.reduce(
    (sum, row) => sum.plus(toDecimalOrZero(row.mix_share_percent)),
    new Decimal(0),
  );

  const validation = validarTotaisBuckets(totalListings, distribution, "monitoring_coverage");

  return {
    total_listings: totalListings,
    monitoring_limit: COMPETITION_HEALTH_MONITORING_LIMIT,
    buckets_sum: validation.buckets_sum,
    unclassified_count: validation.unclassified_count,
    distribution,
    chart: {
      segments,
      mix_segments_sum_percent: formatDecimalFixed(mixSegmentsSum),
    },
  };
}

/** @param {Array<Record<string, unknown>>} allSnapshots @param {number} totalListings */
export function montarDistribuicaoPosicaoPreco(allSnapshots, totalListings) {
  const comparisonSnapshots = filtrarSnapshotsComComparacaoValida(allSnapshots);
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(
    COMPETITION_HEALTH_PRICE_POSITION_BANDS.map((band) => [band.key, 0]),
  );

  for (const snapshot of comparisonSnapshots) {
    const bucketKey = resolverChavePosicaoPreco(snapshot.own_listing, snapshot.competitors);
    if (counts[bucketKey] != null) counts[bucketKey] += 1;
  }

  const baseCount = comparisonSnapshots.length;
  const safeTotal = totalListings > 0 ? totalListings : allSnapshots.length;
  const { distribution, chart } = montarChartSegmentos(
    COMPETITION_HEALTH_PRICE_POSITION_BANDS,
    counts,
    baseCount,
    "listings",
  );

  return {
    total_listings: safeTotal,
    base_label: COMPETITION_HEALTH_PRICE_BASE_LABEL,
    base_count: baseCount,
    compared_listings_count: baseCount,
    comparison_base_count: baseCount,
    buckets_sum: somarBucketsDistribuicao(distribution),
    unclassified_count: Math.max(0, baseCount - somarBucketsDistribuicao(distribution)),
    distribution,
    chart,
  };
}

/** @param {Array<Record<string, unknown>>} allSnapshots */
export function montarDistribuicaoReputacaoConcorrentes(allSnapshots) {
  const competitors = deduplicarConcorrentesAtivosAnalisaveis(allSnapshots);
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(COMPETITION_HEALTH_REPUTATION_BANDS.map((band) => [band.key, 0]));

  for (const competitor of competitors) {
    const bucketKey = resolverChaveReputacaoConcorrente(competitor.reputation);
    if (counts[bucketKey] != null) counts[bucketKey] += 1;
  }

  const totalCompetitors = competitors.length;
  const { distribution, chart } = montarChartSegmentos(
    COMPETITION_HEALTH_REPUTATION_BANDS,
    counts,
    totalCompetitors,
    "competitors",
  );

  return {
    base_label: COMPETITION_HEALTH_REPUTATION_BASE_LABEL,
    total_competitors: totalCompetitors,
    base_count: totalCompetitors,
    buckets_sum: somarBucketsDistribuicao(distribution),
    unclassified_count: Math.max(0, totalCompetitors - somarBucketsDistribuicao(distribution)),
    distribution,
    chart,
  };
}

/** @param {number} count @param {"concorrente" | "anuncio"} [unit] */
function rotuloQuantidade(count, unit = "anuncio") {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (unit === "concorrente") {
    return n === 1 ? "1 concorrente" : `${n} concorrentes`;
  }
  return n === 1 ? "1 anúncio" : `${n} anúncios`;
}

/**
 * @param {Array<Record<string, unknown>>} allSnapshots
 * @param {number} totalListings
 */
export function montarSummaryCardsCentralSaudeConcorrencia(allSnapshots, totalListings) {
  const activeCompetitors = deduplicarConcorrentesAtivosAnalisaveis(allSnapshots);
  const totalActive = activeCompetitors.length;

  let withFreeShipping = 0;
  let withFull = 0;

  for (const competitor of activeCompetitors) {
    const shipping = competitor.shipping;
    if (isFreteGratisConcorrente(shipping)) withFreeShipping += 1;
    if (isConcorrenteLogisticaFull(shipping)) withFull += 1;
  }

  const inactiveCompetitors = listarConcorrentesInativosMonitorados(allSnapshots);
  const inactiveCount = inactiveCompetitors.length;
  const maxPricePressure = calcularMaiorPressaoPreco(allSnapshots);

  return {
    free_shipping_competitors: {
      title: "Concorrentes com frete grátis",
      count: withFreeShipping,
      total_competitors: totalActive,
      percent: formatPercentFromRatio(
        new Decimal(withFreeShipping),
        new Decimal(totalActive > 0 ? totalActive : 0),
      ),
      subtitle: `${withFreeShipping} de ${totalActive} concorrentes têm frete grátis`,
      data_available: totalActive > 0,
    },
    full_competitors: {
      title: "Concorrentes no Full",
      count: withFull,
      total_competitors: totalActive,
      percent: formatPercentFromRatio(
        new Decimal(withFull),
        new Decimal(totalActive > 0 ? totalActive : 0),
      ),
      subtitle: `${withFull} de ${totalActive} concorrentes usam Full`,
      data_available: totalActive > 0,
    },
    max_price_pressure: {
      title: "Maior pressão de preço",
      amount_brl: maxPricePressure.amount_brl,
      display_value: maxPricePressure.display_value,
      subtitle: maxPricePressure.subtitle,
      has_value: maxPricePressure.has_value,
      marketplace_listing_id: maxPricePressure.marketplace_listing_id,
      competitor_id: maxPricePressure.competitor_id,
      competitor_listing_id: maxPricePressure.competitor_listing_id,
      sku: maxPricePressure.sku,
      my_price_brl: maxPricePressure.my_price_brl,
      competitor_price_brl: maxPricePressure.competitor_price_brl,
    },
    inactive_competitors: {
      title: "Concorrentes inativos",
      count: inactiveCount,
      subtitle: `${rotuloQuantidade(inactiveCount, "concorrente")} precisam de revisão`,
      data_available: true,
    },
    data_quality: {
      total_listings: totalListings > 0 ? totalListings : allSnapshots.length,
      active_competitors_count: totalActive,
    },
  };
}

export { somarBucketsDistribuicao };
