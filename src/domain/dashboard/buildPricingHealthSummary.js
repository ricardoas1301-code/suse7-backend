// ======================================================================
// Montagem batch — Central de Saúde da Precificação (Dashboard).
// SSOT: marketplace_listings + health cache + buildMercadoLivrePricingContext.
// Ignora filtro de período do Dashboard — estado atual da precificação.
// ======================================================================

import { buildPricingHealthListingSnapshots } from "../pricing/health/pricingHealthListingSnapshots.js";
import { PRICING_HEALTH_SCOPE } from "../pricing/health/pricingHealthConstants.js";
import {
  logPricingHealthDashboard,
  montarDistribuicaoMargemProjetada,
  montarDistribuicaoPromocoesAnuncios,
  montarDistribuicaoStatusOferta,
  montarSummaryCardsCentralSaudePrecificacao,
} from "../pricing/health/pricingHealthBucketEngine.js";

/** @param {Record<string, unknown>} [metadata] */
export function buildEmptyPricingHealthSummaryPayload(metadata = {}) {
  return {
    ok: true,
    source: "dashboard-pricing-health-summary-ssot",
    metadata,
    total_listings: 0,
    scope: {
      type: PRICING_HEALTH_SCOPE,
      label: "Estado atual da precificação",
      period_preset_ignored: true,
      date_from_ignored: true,
      date_to_ignored: true,
    },
    offer_status: {
      title: "Status da Oferta",
      total_listings: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: { type: "sliced_pie", segments: [], mix_segments_sum_percent: "0.00" },
    },
    projected_margin: {
      title: "Margem Projetada",
      total_listings: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: { type: "sliced_pie", segments: [], mix_segments_sum_percent: "0.00" },
    },
    promotion_status: {
      title: "Promoções dos Anúncios",
      total_listings: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: { type: "sliced_pie", segments: [], mix_segments_sum_percent: "0.00" },
    },
    summary_cards: {
      classic_listings: {
        title: "Anúncios Clássico",
        value: 0,
        count: 0,
        subtitle: "0 de 0 anúncios são Clássico",
        data_available: false,
      },
      premium_listings: {
        title: "Anúncios Premium",
        value: 0,
        count: 0,
        subtitle: "0 de 0 anúncios são Premium",
        data_available: false,
      },
      free_shipping_listings: {
        title: "Com frete grátis",
        value: "0.00",
        count: 0,
        percent: "0.00",
        display_value: "0,00%",
        subtitle: "0 de 0 anúncios têm frete grátis",
        data_available: false,
      },
      active_promotion_listings: {
        title: "Anúncios em promoção",
        value: 0,
        count: 0,
        subtitle: "0 de 0 anúncios estão em promoção ativa",
        data_available: false,
      },
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} [_options]
 */
export async function buildPricingHealthSummary(supabase, userId, _options = {}) {
  const snapshots = await buildPricingHealthListingSnapshots(supabase, userId);
  const totalListings = snapshots.length;

  const offerStatus = montarDistribuicaoStatusOferta(snapshots);
  const projectedMargin = montarDistribuicaoMargemProjetada(snapshots);
  const promotionStatus = montarDistribuicaoPromocoesAnuncios(snapshots);
  const summaryCards = montarSummaryCardsCentralSaudePrecificacao(snapshots, totalListings);

  logPricingHealthDashboard("total_listings", { total_listings: totalListings });
  logPricingHealthDashboard("offer_status buckets sum", {
    buckets_sum: offerStatus.buckets_sum,
    total_listings: totalListings,
  });
  logPricingHealthDashboard("projected_margin buckets sum", {
    buckets_sum: projectedMargin.buckets_sum,
    total_listings: totalListings,
  });
  logPricingHealthDashboard("promotion_status buckets sum", {
    buckets_sum: promotionStatus.buckets_sum,
    total_listings: totalListings,
  });

  return {
    ok: true,
    source: "dashboard-pricing-health-summary-ssot",
    metadata: {
      data_source: "marketplace_listings+marketplace_listing_health+products+buildMercadoLivrePricingContext",
      unit: "listing",
      pricing_scope: PRICING_HEALTH_SCOPE,
      period_filter_ignored: true,
    },
    total_listings: totalListings,
    scope: {
      type: PRICING_HEALTH_SCOPE,
      label: "Estado atual da precificação",
      period_preset_ignored: true,
      date_from_ignored: true,
      date_to_ignored: true,
    },
    offer_status: {
      title: offerStatus.title,
      total_listings: offerStatus.total_listings,
      buckets_sum: offerStatus.buckets_sum,
      unclassified_count: offerStatus.unclassified_count,
      buckets: offerStatus.distribution,
      chart: offerStatus.chart,
    },
    projected_margin: {
      title: projectedMargin.title,
      total_listings: projectedMargin.total_listings,
      buckets_sum: projectedMargin.buckets_sum,
      unclassified_count: projectedMargin.unclassified_count,
      buckets: projectedMargin.distribution,
      chart: projectedMargin.chart,
    },
    promotion_status: {
      title: promotionStatus.title,
      total_listings: promotionStatus.total_listings,
      buckets_sum: promotionStatus.buckets_sum,
      unclassified_count: promotionStatus.unclassified_count,
      buckets: promotionStatus.distribution,
      chart: promotionStatus.chart,
    },
    summary_cards: summaryCards,
  };
}
