// ======================================================================

// Motor de buckets — Central de Saúde da Precificação (Dashboard).

// Unidade: anúncio/listing. Cada listing cai em exatamente 1 bucket por dimensão.

// ======================================================================



import Decimal from "decimal.js";

import {

  PRICING_HEALTH_OFFER_STATUS_BANDS,

  PRICING_HEALTH_PROJECTED_MARGIN_BANDS,

  PRICING_HEALTH_PROMOTION_STATUS_BANDS,

} from "./pricingHealthConstants.js";

import { margemProjetadaCalculavel } from "./pricingHealthFinancialHelpers.js";

import { resolverChaveFaixaMargemComercial } from "../../listings/health/listingCommercialDistribution.js";

import {

  formatDecimalFixed,

  formatPercentFromRatio,

  toDecimalOrZero,

} from "../../products/health/productHealthNumericHelpers.js";

import {

  somarBucketsDistribuicao,

  validarTotaisBuckets,

} from "../../listings/health/listingHealthBucketEngine.js";



const LOG_PREFIX = "[S7_PRICING_HEALTH_DASHBOARD]";



/** Mapeamento faixa comercial → faixa Margem Projetada (Dashboard Precificação). */

const FAIXA_COMERCIAL_PARA_MARGEM_PROJETADA = /** @type {const} */ ({

  excellent_margin: "margin_30_plus",

  healthy_margin: "margin_20_29",

  attention_margin: "margin_10_19",

  critical_margin: "margin_0_9",

  negative_margin: "loss",

  no_commercial_data: "no_data",

});



/** @param {string} label @param {Record<string, unknown>} [payload] */

export function logPricingHealthDashboard(label, payload = {}) {

  if (process.env.NODE_ENV === "production") return;

  console.info(`${LOG_PREFIX} ${label}`, payload);

}



/**

 * Status da Oferta — régua UX simplificada sobre margem projetada.

 * Antes: classifyOfferMarginStatus (critical/danger/acceptable/great/excellent).

 * Agora: >5% saudável | 0–5% atenção | <0% crítico | sem margem = sem dados.

 *

 * @param {Record<string, unknown>} snapshot

 * @returns {string}

 */

export function resolverChaveStatusOferta(snapshot) {

  const margin = snapshot.margin_pct_decimal;

  if (!margemProjetadaCalculavel(margin) || snapshot.has_result !== true) return "no_data";



  const m = /** @type {import("decimal.js").default} */ (margin);

  if (m.lt(0)) return "critical";

  if (m.lte(5)) return "attention";

  return "healthy";

}



/**

 * Margem Projetada — mesmas faixas da Saúde Comercial dos Anúncios.

 * @param {Record<string, unknown>} snapshot

 * @returns {string}

 */

export function resolverChaveMargemProjetada(snapshot) {

  const margin = snapshot.margin_pct_decimal;

  if (!margemProjetadaCalculavel(margin) || snapshot.has_result !== true) return "no_data";



  const commercialKey = resolverChaveFaixaMargemComercial(

    /** @type {import("decimal.js").default} */ (margin),

  );

  return FAIXA_COMERCIAL_PARA_MARGEM_PROJETADA[commercialKey] ?? "no_data";

}



/**

 * Promoções dos Anúncios — bucket já resolvido no snapshot enriquecido.

 * @param {Record<string, unknown>} snapshot

 * @returns {string}

 */

export function resolverChavePromocaoAnuncioBucket(snapshot) {

  const key =

    snapshot.promotion_bucket_key != null ? String(snapshot.promotion_bucket_key).trim() : "";

  if (PRICING_HEALTH_PROMOTION_STATUS_BANDS.some((band) => band.key === key)) return key;

  return "no_promotion";

}



/**

 * @param {ReadonlyArray<{ key: string; label: string; chart_color: string }>} bandDefs

 * @param {Record<string, number>} counts

 * @param {number} totalListings

 */

function montarLinhasDistribuicao(bandDefs, counts, totalListings) {

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

 * @param {number} totalListings

 */

function montarChartSegmentos(bandDefs, counts, totalListings) {

  const distribution = montarLinhasDistribuicao(bandDefs, counts, totalListings);

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



  return {

    distribution,

    chart: {

      type: "sliced_pie",

      segments,

      mix_segments_sum_percent: formatDecimalFixed(mixSegmentsSum),

    },

  };

}



/** @param {Array<Record<string, unknown>>} snapshots */

export function montarDistribuicaoStatusOferta(snapshots) {

  /** @type {Record<string, number>} */

  const counts = Object.fromEntries(PRICING_HEALTH_OFFER_STATUS_BANDS.map((band) => [band.key, 0]));



  for (const snapshot of snapshots) {

    const bucketKey = resolverChaveStatusOferta(snapshot);

    if (counts[bucketKey] != null) counts[bucketKey] += 1;

  }



  const totalListings = snapshots.length;

  const { distribution, chart } = montarChartSegmentos(

    PRICING_HEALTH_OFFER_STATUS_BANDS,

    counts,

    totalListings,

  );

  const validation = validarTotaisBuckets(totalListings, distribution, "offer_status");



  return {

    title: "Status da Oferta",

    total_listings: totalListings,

    buckets_sum: validation.buckets_sum,

    unclassified_count: validation.unclassified_count,

    distribution,

    chart,

  };

}



/** @param {Array<Record<string, unknown>>} snapshots */

export function montarDistribuicaoMargemProjetada(snapshots) {

  /** @type {Record<string, number>} */

  const counts = Object.fromEntries(

    PRICING_HEALTH_PROJECTED_MARGIN_BANDS.map((band) => [band.key, 0]),

  );



  for (const snapshot of snapshots) {

    const bucketKey = resolverChaveMargemProjetada(snapshot);

    if (counts[bucketKey] != null) counts[bucketKey] += 1;

  }



  const totalListings = snapshots.length;

  const { distribution, chart } = montarChartSegmentos(

    PRICING_HEALTH_PROJECTED_MARGIN_BANDS,

    counts,

    totalListings,

  );

  const validation = validarTotaisBuckets(totalListings, distribution, "projected_margin");



  return {

    title: "Margem Projetada",

    total_listings: totalListings,

    buckets_sum: validation.buckets_sum,

    unclassified_count: validation.unclassified_count,

    distribution,

    chart,

  };

}



/** @param {Array<Record<string, unknown>>} snapshots */

export function montarDistribuicaoPromocoesAnuncios(snapshots) {

  /** @type {Record<string, number>} */

  const counts = Object.fromEntries(

    PRICING_HEALTH_PROMOTION_STATUS_BANDS.map((band) => [band.key, 0]),

  );



  for (const snapshot of snapshots) {

    const bucketKey = resolverChavePromocaoAnuncioBucket(snapshot);

    if (counts[bucketKey] != null) counts[bucketKey] += 1;

  }



  const totalListings = snapshots.length;

  const { distribution, chart } = montarChartSegmentos(

    PRICING_HEALTH_PROMOTION_STATUS_BANDS,

    counts,

    totalListings,

  );

  const validation = validarTotaisBuckets(totalListings, distribution, "promotion_status");



  return {

    title: "Promoções dos Anúncios",

    total_listings: totalListings,

    buckets_sum: validation.buckets_sum,

    unclassified_count: validation.unclassified_count,

    distribution,

    chart,

  };

}



/** @param {number} count @param {number} total */

function rotuloDeTotal(count, total) {

  const n = Math.max(0, Math.trunc(Number(count) || 0));

  const t = Math.max(0, Math.trunc(Number(total) || 0));

  const anuncios = n === 1 ? "1 anúncio" : `${n} anúncios`;

  const totalLabel = t === 1 ? "1 anúncio" : `${t} anúncios`;

  return `${anuncios} de ${totalLabel}`;

}



/**

 * @param {Array<Record<string, unknown>>} snapshots

 * @param {number} totalListings

 */

export function montarSummaryCardsCentralSaudePrecificacao(snapshots, totalListings) {

  let classicListings = 0;

  let premiumListings = 0;

  let freeShippingListings = 0;

  let activePromotionListings = 0;



  for (const snapshot of snapshots) {

    if (snapshot.listing_type_key === "classic") classicListings += 1;

    if (snapshot.listing_type_key === "premium") premiumListings += 1;

    if (snapshot.free_shipping === true) freeShippingListings += 1;

    if (snapshot.has_active_promotion === true || snapshot.promotion_bucket_key === "active_promotion") {

      activePromotionListings += 1;

    }

  }



  const safeTotal = totalListings > 0 ? totalListings : snapshots.length;

  const freeShippingPercent = formatPercentFromRatio(

    new Decimal(freeShippingListings),

    new Decimal(safeTotal > 0 ? safeTotal : 0),

  );



  return {

    classic_listings: {

      title: "Anúncios Clássico",

      value: classicListings,

      count: classicListings,

      total_listings: safeTotal,

      subtitle: `${rotuloDeTotal(classicListings, safeTotal)} são Clássico`,

      data_available: safeTotal > 0,

    },

    premium_listings: {

      title: "Anúncios Premium",

      value: premiumListings,

      count: premiumListings,

      total_listings: safeTotal,

      subtitle: `${rotuloDeTotal(premiumListings, safeTotal)} são Premium`,

      data_available: safeTotal > 0,

    },

    free_shipping_listings: {

      title: "Com frete grátis",

      value: freeShippingPercent,

      count: freeShippingListings,

      total_listings: safeTotal,

      percent: freeShippingPercent,

      display_value: freeShippingPercent,

      subtitle: `${rotuloDeTotal(freeShippingListings, safeTotal)} têm frete grátis`,

      data_available: safeTotal > 0,

    },

    active_promotion_listings: {

      title: "Anúncios em promoção",

      value: activePromotionListings,

      count: activePromotionListings,

      total_listings: safeTotal,

      subtitle: `${rotuloDeTotal(activePromotionListings, safeTotal)} estão em promoção ativa`,

      data_available: safeTotal > 0,

    },

  };

}



export { somarBucketsDistribuicao };


