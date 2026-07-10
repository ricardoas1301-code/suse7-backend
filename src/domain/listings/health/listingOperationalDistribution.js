// ======================================================================
// Agregação por faixa — card Saúde operacional (Dashboard executivo).
// Partição exaustiva: 1 listing = 1 bucket operacional.
// ======================================================================

import { LISTING_HEALTH_OPERATIONAL_DISTRIBUTION_BANDS } from "./listingHealthConstants.js";
import {
  montarContagemBucketsExclusiva,
  resolverChaveBucketOperacionalExclusivo,
  validarTotaisBuckets,
} from "./listingHealthBucketEngine.js";

/**
 * Monta distribuição agregada da saúde operacional (buckets exclusivos).
 *
 * @param {Array<{
 *   listing_id?: string;
 *   status?: string | null;
 *   status_normalized?: string;
 *   available_quantity?: number | null;
 * }>} snapshots
 */
export function montarDistribuicaoSaudeOperacional(snapshots) {
  const items = snapshots.map((snapshot) => ({
    listing_id: snapshot.listing_id != null ? String(snapshot.listing_id) : "",
    snapshot,
  }));

  const { counts } = montarContagemBucketsExclusiva(
    items,
    resolverChaveBucketOperacionalExclusivo,
    LISTING_HEALTH_OPERATIONAL_DISTRIBUTION_BANDS,
  );

  const pausedCount = counts.paused ?? 0;
  const inactiveCount = counts.inactive ?? 0;
  const activeCount = counts.active ?? 0;

  const totalListings = snapshots.length;

  const distribution = LISTING_HEALTH_OPERATIONAL_DISTRIBUTION_BANDS.map((bandDef) => ({
    key: bandDef.key,
    label: bandDef.label,
    short_label: bandDef.short_label,
    step_label: bandDef.step_label,
    severity: bandDef.severity,
    count: counts[bandDef.key] ?? 0,
  }));

  const validation = validarTotaisBuckets(totalListings, distribution, "operacional");

  return {
    total_listings: totalListings,
    active_count: activeCount,
    critical_stock_count: counts.critical_stock ?? 0,
    zero_stock_count: counts.zero_stock ?? 0,
    paused_count: pausedCount,
    inactive_count: inactiveCount,
    offline_count: pausedCount + inactiveCount,
    buckets_sum: validation.buckets_sum,
    unclassified_count: validation.unclassified_count,
    distribution,
  };
}

/** Payload vazio — fallback seguro. */
export function buildEmptyOperationalHealthDistribution() {
  return {
    title: "Saúde operacional",
    total_listings: 0,
    active_count: 0,
    critical_stock_count: 0,
    zero_stock_count: 0,
    paused_count: 0,
    inactive_count: 0,
    offline_count: 0,
    buckets_sum: 0,
    unclassified_count: 0,
    distribution: LISTING_HEALTH_OPERATIONAL_DISTRIBUTION_BANDS.map((bandDef) => ({
      key: bandDef.key,
      label: bandDef.label,
      short_label: bandDef.short_label,
      step_label: bandDef.step_label,
      severity: bandDef.severity,
      count: 0,
    })),
  };
}
