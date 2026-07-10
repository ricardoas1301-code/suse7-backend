// ======================================================

// Enriquece grid GET /api/ml/listings com pricing_current_state_projected_unit.

// local_only=1: leitura rápida do read-model persistido (sem engine em massa).

// ======================================================



import { getValidMLToken } from "./mlToken.js";

import { getListingGridRow } from "./listingGridJoinKeys.js";

import {

  buildPricingCurrentStateProjectedUnitFromEngine,

  logPricingCurrentEffectivePriceParity,

  logPricingListModalParityAudit,

} from "../../../domain/pricing/buildPricingCurrentStateProjectedUnitFromEngine.js";

import { buildPricingCurrentStateRowContract, logPricingCurrentStateRowAudit } from "../../../domain/pricing/buildPricingCurrentStateRowContract.js";

import {

  buildPricingEngineErrorContract,

  logPricingEngineRowError,

  logPricingEngineRowOk,

  logPricingListLoadFatal,

} from "../../../domain/pricing/buildPricingCurrentStateEngineResilience.js";

import {

  buildPricingCurrentStateReadModelMissGridFallbackContract,

  logPricingListPerformance,

  logPricingReadModelHit,

  logPricingReadModelMiss,

  parseRecalcExternalListingIds,

  persistPricingCurrentStateReadModel,

  readPricingCurrentStateReadModelFromListing,

} from "../../../domain/pricing/listingPricingCurrentStateReadModel.js";



const DEFAULT_MAX_SYNC_ENGINE_RUNS = 0;



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {Record<string, unknown>[]} gridRows

 * @param {Record<string, unknown>[]} listings

 * @param {Map<string, Record<string, unknown>>} healthByKey

 * @param {{ localOnly?: boolean; recalcExternalListingIds?: string | null }} [options]

 */

export async function enrichListingGridRowsPricingCurrentStateProjectedUnit(

  supabase,

  userId,

  gridRows,

  listings,

  healthByKey,

  options = {},

) {

  const localOnly = options.localOnly === true;

  const startedMs = Date.now();



  if (!Array.isArray(gridRows) || gridRows.length === 0) {

    logPricingListPerformance({

      totalListings: 0,

      localOnly,

      readModelHits: 0,

      readModelMisses: 0,

      syncEngineRunsCount: 0,

      skippedEngineRunsCount: 0,

      durationMs: Date.now() - startedMs,

    });

    return;

  }



  /** @type {Map<string, Record<string, unknown>>} */

  const listingById = new Map();

  for (const listing of listings ?? []) {

    if (listing?.id != null) listingById.set(String(listing.id), listing);

  }



  const recalcIds = parseRecalcExternalListingIds(options.recalcExternalListingIds);

  const maxEngineRuns = localOnly

    ? Math.min(

        recalcIds.size,

        Number.parseInt(process.env.S7_PRICING_LIST_MAX_SYNC_ENGINE_RUNS ?? String(DEFAULT_MAX_SYNC_ENGINE_RUNS), 10) ||

          DEFAULT_MAX_SYNC_ENGINE_RUNS,

      )

    : Number.parseInt(process.env.S7_PRICING_LIST_MAX_SYNC_ENGINE_RUNS ?? "0", 10) || 0;



  let readModelHits = 0;

  let readModelMisses = 0;

  let syncEngineRunsCount = 0;

  let skippedEngineRunsCount = 0;



  let mlAccessToken = null;

  if (!localOnly && maxEngineRuns > 0) {

    try {

      mlAccessToken = await getValidMLToken(userId);

    } catch (e) {

      console.info("[S7_PRICING_LIST_ENGINE] ml_token_unavailable", {

        message: e instanceof Error ? e.message : String(e),

      });

    }

  }



  const referenceZipCode =

    process.env.SUSE7_ML_PRICING_REFERENCE_ZIP?.trim() ||

    process.env.ML_PRICING_REFERENCE_ZIP?.trim() ||

    "01310100";



  try {

    for (let rowIdx = 0; rowIdx < gridRows.length; rowIdx++) {

      const gridRow = gridRows[rowIdx];

      if (!gridRow || typeof gridRow !== "object") continue;



      const listingId = gridRow.id != null ? String(gridRow.id) : "";

      const listing = listingById.get(listingId);

      const externalId =

        gridRow.external_listing_id != null

          ? String(gridRow.external_listing_id).trim()

          : listing?.external_listing_id != null

            ? String(listing.external_listing_id).trim()

            : "";



      const persisted = listing ? readPricingCurrentStateReadModelFromListing(listing) : null;

      const shouldRunEngine =

        maxEngineRuns > 0 && recalcIds.has(externalId) && syncEngineRunsCount < maxEngineRuns;



      if (shouldRunEngine && listing) {

        const marketplace =

          gridRow.marketplace != null ? String(gridRow.marketplace) : String(listing.marketplace ?? "");

        const health = getListingGridRow(

          healthByKey,

          marketplace,

          gridRow.external_listing_id ?? listing.external_listing_id,

        );

        try {

          const contract = await buildPricingCurrentStateProjectedUnitFromEngine({

            supabase,

            userId,

            gridRow,

            listing,

            health,

            mlAccessToken: localOnly ? null : mlAccessToken,

            referenceZipCode,

            localOnly: true,

          });

          await persistPricingCurrentStateReadModel(supabase, userId, String(listing.id), contract, {

            source: "list_recalc_single_row",

          });

          gridRow.pricing_current_state = contract;

          syncEngineRunsCount += 1;

          logPricingReadModelHit(contract);

          logPricingListModalParityAudit(contract);

          logPricingEngineRowOk(contract, gridRow);

        } catch (err) {

          logPricingEngineRowError({ gridRow, listing, health, err, fallbackUsed: "single_row_recalc" });

          gridRow.pricing_current_state = buildPricingEngineErrorContract({

            gridRow,

            listing,

            health,

            errorMessage: err instanceof Error ? err.message : String(err),

            fallbackUsed: "single_row_recalc",

          });

        }

        continue;

      }



      if (persisted) {

        gridRow.pricing_current_state = persisted;

        readModelHits += 1;

        if (rowIdx < 5 || externalId === "MLB6086602390" || externalId === "MLB6784329822") {

          logPricingCurrentStateRowAudit(persisted);

          logPricingCurrentEffectivePriceParity(persisted);

        }

        logPricingReadModelHit(persisted);

        continue;

      }



      readModelMisses += 1;

      if (recalcIds.has(externalId) && syncEngineRunsCount >= maxEngineRuns) {

        skippedEngineRunsCount += 1;

      }



      logPricingReadModelMiss({

        gridRow,

        listing,

        reason: "pricing_current_state_not_calculated",

        scheduledRecalc: false,

      });



      gridRow.pricing_current_state = buildPricingCurrentStateReadModelMissGridFallbackContract(gridRow, listing);

    }

  } catch (fatalErr) {

    logPricingListLoadFatal({

      route: "/api/ml/listings",

      localOnly,

      userId,

      err: fatalErr,

      stage: "pricing_read_model_attach_batch",

    });

    for (const gridRow of gridRows) {

      if (!gridRow || typeof gridRow !== "object") continue;

      if (gridRow.pricing_current_state != null) continue;

      try {

        gridRow.pricing_current_state = buildPricingCurrentStateReadModelMissGridFallbackContract(
          /** @type {Record<string, unknown>} */ (gridRow),
          listingById.get(String(gridRow.id ?? "")) ?? null,
        );

      } catch {

        gridRow.pricing_current_state = buildPricingEngineErrorContract({

          gridRow: /** @type {Record<string, unknown>} */ (gridRow),

          errorMessage: "pricing_read_model_batch_fatal",

          fallbackUsed: "batch_fatal_fallback",

        });

      }

    }

  } finally {

    logPricingListPerformance({

      totalListings: gridRows.length,

      localOnly,

      readModelHits,

      readModelMisses,

      syncEngineRunsCount,

      skippedEngineRunsCount,

      durationMs: Date.now() - startedMs,

    });

  }

}


