// ======================================================================
// Motor exaustivo de buckets — Central de Saúde dos Anúncios (Dashboard).
// Cada listing_id cai em exatamente 1 bucket por dimensão.
// ======================================================================

import {
  LISTING_HEALTH_COMMERCIAL_DISTRIBUTION_BANDS,
  LISTING_HEALTH_OPERATIONAL_DISTRIBUTION_BANDS,
  LISTING_HEALTH_REGISTRATION_DISTRIBUTION_BANDS,
} from "./listingHealthConstants.js";
import { classificarEstoqueOperacional } from "./listingHealthClassifier.js";
import {
  resolverChaveFaixaMargemComercial,
  resolverMargemHistoricaAnuncio,
} from "./listingCommercialDistribution.js";
import {
  normalizarScoreQualidadeCadastro,
  resolverChaveFaixaScoreCadastro,
} from "./listingRegistrationDistribution.js";

const LOG_PREFIX = "[S7_LISTING_HEALTH_DASHBOARD]";

/** @param {string} label @param {Record<string, unknown>} [payload] */
export function logListingHealthDashboard(label, payload = {}) {
  if (process.env.NODE_ENV === "production") return;
  console.info(`${LOG_PREFIX} ${label}`, payload);
}

/**
 * Bucket operacional exclusivo — prioridade de negócio (1 listing = 1 bucket).
 *
 * @param {{
 *   status_normalized?: string;
 *   status?: string | null;
 *   available_quantity?: number | null;
 * }} snapshot
 * @returns {string}
 */
export function resolverChaveBucketOperacionalExclusivo(snapshot) {
  const status =
    snapshot.status_normalized != null ? String(snapshot.status_normalized) : "unknown";
  const rawStatus = String(snapshot.status ?? "")
    .trim()
    .toLowerCase();
  const stock = classificarEstoqueOperacional(snapshot);

  // 1. Inativos / encerrados / status finalizado
  if (
    status === "inactive" ||
    rawStatus === "closed" ||
    rawStatus === "not_yet_active" ||
    rawStatus === "deleted"
  ) {
    return "inactive";
  }

  // 2. Pausados / revisão / pendências operacionais
  if (
    status === "paused" ||
    rawStatus === "under_review" ||
    rawStatus === "pending" ||
    rawStatus === "waiting_for_patch" ||
    rawStatus === "payment_required"
  ) {
    return "paused";
  }

  // 3. Sem estoque
  if (stock.is_zero_stock) return "zero_stock";

  // 4. Estoque crítico
  if (stock.is_critical_stock) return "critical_stock";

  // 5. Ativos saudáveis
  if (status === "active") return "active";

  // 6. Fallback — status desconhecido / não mapeado → inativo (fora do ar operacional)
  return "inactive";
}

/**
 * Bucket comercial exclusivo — margem calculável ou bucket sem dados.
 *
 * @param {{
 *   status_normalized?: string;
 *   sales_count?: number;
 *   profit_margin_percent?: string | number | null;
 *   profit_brl?: string | number | null;
 *   gross_revenue_brl?: string | number | null;
 * }} snapshot
 * @returns {string}
 */
export function resolverChaveBucketComercialExclusivo(snapshot) {
  const sales = Number(snapshot.sales_count ?? 0);
  const hasSales = Number.isFinite(sales) && sales > 0;

  if (!hasSales) return "no_commercial_data";

  const marginDec = resolverMargemHistoricaAnuncio(snapshot);
  if (marginDec == null) return "no_commercial_data";

  return resolverChaveFaixaMargemComercial(marginDec);
}

/**
 * @param {{
 *   health_score?: number | null;
 *   listing_quality_score?: number | null;
 * }} snapshot
 * @returns {string}
 */
export function resolverChaveBucketCadastroExclusivo(snapshot) {
  const rawScore = snapshot.listing_quality_score ?? snapshot.health_score;
  const { score } = normalizarScoreQualidadeCadastro(rawScore);
  return resolverChaveFaixaScoreCadastro(score);
}

/** @param {Array<{ count?: number }>} distribution */
export function somarBucketsDistribuicao(distribution) {
  return distribution.reduce((sum, row) => sum + Math.max(0, Number(row.count ?? 0) || 0), 0);
}

/**
 * @param {number} totalListings
 * @param {Array<{ count?: number; key?: string }>} distribution
 * @param {string} dimension
 * @param {string[]} [listingIdsUnclassified]
 */
export function validarTotaisBuckets(totalListings, distribution, dimension, listingIdsUnclassified = []) {
  const bucketsSum = somarBucketsDistribuicao(distribution);
  const unclassifiedCount = Math.max(0, totalListings - bucketsSum);

  logListingHealthDashboard(`${dimension} buckets sum`, {
    total_listings: totalListings,
    buckets_sum: bucketsSum,
    unclassified_count: unclassifiedCount,
  });

  if (unclassifiedCount > 0 && listingIdsUnclassified.length > 0) {
    logListingHealthDashboard(`${dimension} unclassified listing ids`, {
      count: listingIdsUnclassified.length,
      sample_ids: listingIdsUnclassified.slice(0, 20),
    });
  }

  return {
    buckets_sum: bucketsSum,
    unclassified_count: unclassifiedCount,
    valid: unclassifiedCount === 0 && bucketsSum === totalListings,
  };
}

/**
 * @param {Array<{ listing_id?: string; snapshot: Record<string, unknown> }>} items
 * @param {(snapshot: Record<string, unknown>) => string} resolver
 * @param {ReadonlyArray<{ key: string }>} bandDefs
 */
export function montarContagemBucketsExclusiva(items, resolver, bandDefs) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(bandDefs.map((band) => [band.key, 0]));
  /** @type {string[]} */
  const unclassifiedIds = [];

  for (const item of items) {
    const bucketKey = resolver(item.snapshot);
    if (counts[bucketKey] != null) {
      counts[bucketKey] += 1;
    } else {
      unclassifiedIds.push(String(item.listing_id ?? ""));
      const fallbackKey = bandDefs[bandDefs.length - 1]?.key;
      if (fallbackKey && counts[fallbackKey] != null) counts[fallbackKey] += 1;
    }
  }

  return { counts, unclassifiedIds };
}

export {
  LISTING_HEALTH_COMMERCIAL_DISTRIBUTION_BANDS,
  LISTING_HEALTH_OPERATIONAL_DISTRIBUTION_BANDS,
  LISTING_HEALTH_REGISTRATION_DISTRIBUTION_BANDS,
};
