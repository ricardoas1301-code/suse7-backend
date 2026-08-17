// ======================================================================
// Montagem batch — Central de Saúde da Concorrência (Dashboard).
// SSOT: marketplace_listings (total) + competition_monitored_listings + snapshots.
// Ignora filtro de período do Dashboard — estado atual do monitoramento.
// ======================================================================

import { buildCompetitionHealthListingSnapshots } from "../competition/health/competitionHealthListingSnapshots.js";
import { COMPETITION_HEALTH_SCOPE } from "../competition/health/competitionHealthConstants.js";
import {
  logCompetitionHealthDashboard,
  montarDistribuicaoCoberturaMonitoramento,
  montarDistribuicaoPosicaoPreco,
  montarDistribuicaoReputacaoConcorrentes,
  montarSummaryCardsCentralSaudeConcorrencia,
} from "../competition/health/competitionHealthBucketEngine.js";

/** @param {Record<string, unknown>} [metadata] */
export function buildEmptyCompetitionHealthSummaryPayload(metadata = {}) {
  return {
    ok: true,
    source: "dashboard-competition-health-summary-ssot",
    metadata,
    total_listings: 0,
    monitored_listings_count: 0,
    comparison_base_count: 0,
    total_competitors: 0,
    scope: {
      type: COMPETITION_HEALTH_SCOPE,
      label: "Estado atual do monitoramento",
      period_preset_ignored: true,
      date_from_ignored: true,
      date_to_ignored: true,
    },
    monitoring_coverage: {
      title: "Cobertura de Monitoramento",
      total_listings: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: { segments: [], mix_segments_sum_percent: "0.00" },
    },
    price_position: {
      title: "Posição de Preço",
      total_listings: 0,
      base_label: "Comparados",
      base_count: 0,
      compared_listings_count: 0,
      comparison_base_count: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: { segments: [], mix_segments_sum_percent: "0.00" },
    },
    competitor_reputation: {
      title: "Reputação dos Concorrentes",
      base_label: "Concorrentes analisados",
      total_competitors: 0,
      base_count: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: { segments: [], mix_segments_sum_percent: "0.00" },
    },
    summary_cards: {
      free_shipping_competitors: {
        title: "Concorrentes com frete grátis",
        count: 0,
        total_competitors: 0,
        percent: "0.00",
        subtitle: "0 de 0 concorrentes têm frete grátis",
        data_available: false,
      },
      full_competitors: {
        title: "Concorrentes no Full",
        count: 0,
        total_competitors: 0,
        percent: "0.00",
        subtitle: "0 de 0 concorrentes usam Full",
        data_available: false,
      },
      max_price_pressure: {
        title: "Maior pressão de preço",
        amount_brl: null,
        display_value: null,
        subtitle: "Nenhum concorrente abaixo do seu preço",
        has_value: false,
        marketplace_listing_id: null,
        competitor_id: null,
        competitor_listing_id: null,
        sku: null,
        my_price_brl: null,
        competitor_price_brl: null,
      },
      inactive_competitors: {
        title: "Concorrentes inativos",
        count: 0,
        subtitle: "0 concorrentes precisam de revisão",
        data_available: true,
      },
      data_quality: {
        total_listings: 0,
        active_competitors_count: 0,
      },
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} [_options]
 */
export async function buildCompetitionHealthSummary(supabase, userId, _options = {}) {
  const snapshots = await buildCompetitionHealthListingSnapshots(supabase, userId);
  const totalListings = snapshots.length;

  const monitoringCoverage = montarDistribuicaoCoberturaMonitoramento(snapshots);
  const pricePosition = montarDistribuicaoPosicaoPreco(snapshots, totalListings);
  const competitorReputation = montarDistribuicaoReputacaoConcorrentes(snapshots);
  const summaryCards = montarSummaryCardsCentralSaudeConcorrencia(snapshots, totalListings);

  const monitoredListingsCount = snapshots.filter(
    (row) => Math.max(0, Math.trunc(Number(row.competitors_count) || 0)) > 0,
  ).length;

  logCompetitionHealthDashboard("total_listings", { total_listings: totalListings });
  logCompetitionHealthDashboard("monitoring_coverage buckets sum", {
    buckets_sum: monitoringCoverage.buckets_sum,
    total_listings: totalListings,
  });
  logCompetitionHealthDashboard("price_position base", {
    total_listings: pricePosition.total_listings,
    compared_listings_count: pricePosition.compared_listings_count,
    buckets_sum: pricePosition.buckets_sum,
  });
  logCompetitionHealthDashboard("competitor_reputation base", {
    total_competitors: competitorReputation.total_competitors,
    buckets_sum: competitorReputation.buckets_sum,
  });

  return {
    ok: true,
    source: "dashboard-competition-health-summary-ssot",
    metadata: {
      data_source:
        "marketplace_listings+competition_monitored_listings+competition_competitors+competition_snapshots",
      unit: "listing",
      monitoring_scope: COMPETITION_HEALTH_SCOPE,
      period_filter_ignored: true,
    },
    total_listings: totalListings,
    monitored_listings_count: monitoredListingsCount,
    comparison_base_count: pricePosition.base_count,
    total_competitors: competitorReputation.total_competitors,
    scope: {
      type: COMPETITION_HEALTH_SCOPE,
      label: "Estado atual do monitoramento",
      period_preset_ignored: true,
      date_from_ignored: true,
      date_to_ignored: true,
    },
    monitoring_coverage: {
      title: "Cobertura de Monitoramento",
      total_listings: monitoringCoverage.total_listings,
      monitoring_limit: monitoringCoverage.monitoring_limit,
      buckets_sum: monitoringCoverage.buckets_sum,
      unclassified_count: monitoringCoverage.unclassified_count,
      buckets: monitoringCoverage.distribution,
      chart: monitoringCoverage.chart,
    },
    price_position: {
      title: "Posição de Preço",
      total_listings: pricePosition.total_listings,
      base_label: pricePosition.base_label,
      base_count: pricePosition.base_count,
      compared_listings_count: pricePosition.compared_listings_count,
      comparison_base_count: pricePosition.comparison_base_count,
      buckets_sum: pricePosition.buckets_sum,
      unclassified_count: pricePosition.unclassified_count,
      buckets: pricePosition.distribution,
      chart: pricePosition.chart,
    },
    competitor_reputation: {
      title: "Reputação dos Concorrentes",
      base_label: competitorReputation.base_label,
      total_competitors: competitorReputation.total_competitors,
      base_count: competitorReputation.base_count,
      buckets_sum: competitorReputation.buckets_sum,
      unclassified_count: competitorReputation.unclassified_count,
      buckets: competitorReputation.distribution,
      chart: competitorReputation.chart,
    },
    summary_cards: summaryCards,
  };
}
