// ======================================================================

// Agregação por faixa — card Saúde do cadastro (Dashboard executivo).

// Score oficial 0–100 (ML performance/health sincronizado); sem N+1.

// ======================================================================



import Decimal from "decimal.js";
import { LISTING_HEALTH_REGISTRATION_DISTRIBUTION_BANDS } from "./listingHealthConstants.js";
import {
  validarTotaisBuckets,
  logListingHealthDashboard,
} from "./listingHealthBucketEngine.js";



/** Metadados visuais por faixa — mini gauge no Dashboard. */

const BAND_VISUAL_META = {

  complete: { short_label: "100%", gauge_value: 100, severity: "complete" },

  excellent: { short_label: "90–99%", gauge_value: 95, severity: "excellent" },

  attention: { short_label: "70–89%", gauge_value: 80, severity: "attention" },

  critical: { short_label: "50–69%", gauge_value: 60, severity: "critical" },

  urgent: { short_label: "<50%", gauge_value: 25, severity: "urgent" },

};



/** @param {string} bandKey */

function visualMetaForBand(bandKey) {

  return (

    BAND_VISUAL_META[/** @type {keyof typeof BAND_VISUAL_META} */ (bandKey)] ?? {

      short_label: "—",

      gauge_value: 0,

      severity: "attention",

    }

  );

}



/**

 * Normaliza score de qualidade para bucket 0–100.

 * Score ausente → 0 (faixa "Abaixo de 50%"), com flag has_score=false.

 *

 * @param {unknown} rawScore

 * @returns {{ score: number; has_score: boolean }}

 */

export function normalizarScoreQualidadeCadastro(rawScore) {

  if (rawScore == null || String(rawScore).trim() === "") {

    return { score: 0, has_score: false };

  }

  const n = Number(rawScore);

  if (!Number.isFinite(n)) {

    return { score: 0, has_score: false };

  }

  if (n > 0 && n <= 1) {

    return { score: Math.max(0, Math.min(100, Math.round(n * 100))), has_score: true };

  }

  return { score: Math.max(0, Math.min(100, Math.round(n))), has_score: true };

}



/**

 * @param {number} score Score já normalizado 0–100.

 * @returns {string}

 */

export function resolverChaveFaixaScoreCadastro(score) {

  if (score === 100) return "complete";

  if (score >= 90) return "excellent";

  if (score >= 70) return "attention";

  if (score >= 50) return "critical";

  return "urgent";

}



/**

 * Monta distribuição agregada por faixa de qualidade de cadastro.

 *

 * @param {Array<{

 *   health_score?: number | null;

 *   pending_goals_count?: number;

 *   listing_quality_score?: number | null;

 * }>} snapshots

 * @param {{ total_needs_improvement?: number }} [options]

 */

export function montarDistribuicaoSaudeCadastro(snapshots, options = {}) {

  /** @type {Record<string, { count: number; total_pending_goals: number; no_score_count: number }>} */

  const aggByKey = Object.fromEntries(

    LISTING_HEALTH_REGISTRATION_DISTRIBUTION_BANDS.map((band) => [

      band.key,

      { count: 0, total_pending_goals: 0, no_score_count: 0 },

    ]),

  );



  for (const snapshot of snapshots) {

    const rawScore = snapshot.listing_quality_score ?? snapshot.health_score;

    const { score, has_score } = normalizarScoreQualidadeCadastro(rawScore);

    const bandKey = resolverChaveFaixaScoreCadastro(score);

    const agg = aggByKey[bandKey];

    if (!agg) continue;

    agg.count += 1;

    agg.total_pending_goals += Math.max(0, Number(snapshot.pending_goals_count ?? 0) || 0);

    if (!has_score) agg.no_score_count += 1;

  }



  const totalListings = snapshots.length;

  const completeCount = aggByKey.complete?.count ?? 0;

  const below100Count = totalListings - completeCount;



  const distribution = LISTING_HEALTH_REGISTRATION_DISTRIBUTION_BANDS.map((bandDef) => {

    const agg = aggByKey[bandDef.key] ?? { count: 0, total_pending_goals: 0, no_score_count: 0 };

    const avgPendingGoals =

      agg.count > 0

        ? new Decimal(agg.total_pending_goals)

            .div(agg.count)

            .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)

            .toFixed(1)

        : "0";



    const visual = visualMetaForBand(bandDef.key);



    return {

      key: bandDef.key,

      label: bandDef.label,

      short_label: visual.short_label,

      gauge_value: visual.gauge_value,

      severity: visual.severity,

      min_score: bandDef.min_score,

      max_score: bandDef.max_score,

      count: agg.count,

      total_pending_goals: agg.total_pending_goals,

      avg_pending_goals: avgPendingGoals,

      no_score_count: agg.no_score_count,

    };

  });



  const validation = validarTotaisBuckets(totalListings, distribution, "cadastro");

  logListingHealthDashboard("total_listings", { total_listings: totalListings });

  return {

    total_listings: totalListings,

    below_100_count: below100Count,

    total_needs_improvement:

      options.total_needs_improvement != null ? options.total_needs_improvement : below100Count,

    buckets_sum: validation.buckets_sum,

    unclassified_count: validation.unclassified_count,

    distribution,

  };

}



/**

 * Payload vazio da distribuição — fallback seguro.

 */

export function buildEmptyRegistrationHealthDistribution() {

  return {

    title: "Saúde do cadastro",

    total_listings: 0,

    total_needs_improvement: 0,

    below_100_count: 0,

    buckets_sum: 0,

    unclassified_count: 0,

    distribution: LISTING_HEALTH_REGISTRATION_DISTRIBUTION_BANDS.map((bandDef) => {

      const visual = visualMetaForBand(bandDef.key);

      return {

        key: bandDef.key,

        label: bandDef.label,

        short_label: visual.short_label,

        gauge_value: visual.gauge_value,

        severity: visual.severity,

        min_score: bandDef.min_score,

        max_score: bandDef.max_score,

        count: 0,

        total_pending_goals: 0,

        avg_pending_goals: "0",

        no_score_count: 0,

      };

    }),

  };

}


