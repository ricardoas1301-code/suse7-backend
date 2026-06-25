// ============================================================
// S7 — Concorrência: enrich obrigatório antes de persistir
// ============================================================

import { enrichCompetitorListing } from "./competitionListingEnricher.js";
import { competitorPatchFromEnrichedRaw, normalizeDiscoveredCompetitor, normalizeCompetitorPictureUrls } from "./competitionNormalizer.js";
import {
  hasPersistedLiveCommercialData,
  ML_LISTING_STATUS_INFERIDO_POR_HTTP,
  resolveListingStatusPersistUpdate,
} from "./competitionListingStatus.js";
import {
  enrichWithTimeout,
  isEnrichResultComplete,
  listMissingCriticalMetaFields,
  listMissingCriticalPersistFields,
  mergeSalesHintPreserve,
  summarizeEnrichRawForLog,
} from "./competitionEnrichHelpers.js";
import { runDirectItemSoldQuantityAudit } from "./competitionDirectItemAudit.js";
import { logSalesPipelineTrace } from "./competitionSalesPipelineTrace.js";
import {
  applySalesHintResolutionToExtras,
  resolveCompetitionSalesHint,
} from "./competitionSalesHintResolver.js";
import { competitionSalesAuditEnabled } from "./competitionSalesMlAudit.js";

function mergeInitialEnrichExtras(extras, initialExtras = {}) {
  const init = initialExtras && typeof initialExtras === "object" ? initialExtras : {};
  const out = { ...extras };
  out.sales_hint = mergeSalesHintPreserve(out, init, out.sales_hint, init.sales_hint);
  const initShip = init.shipping && typeof init.shipping === "object" ? init.shipping : null;
  const outShip = out.shipping && typeof out.shipping === "object" ? out.shipping : {};
  if (
    initShip &&
    (initShip.free_shipping === true || initShip.mode || initShip.logistic_type) &&
    !outShip.free_shipping &&
    !outShip.mode &&
    !outShip.logistic_type
  ) {
    out.shipping = initShip;
  }
  if (!out.listing_type && init.listing_type) out.listing_type = init.listing_type;
  const initRep = init.reputation && typeof init.reputation === "object" ? init.reputation : null;
  const outRep = out.reputation && typeof out.reputation === "object" ? out.reputation : {};
  if (initRep && (initRep.level_id || initRep.power_seller_status) && !outRep.level_id && !outRep.power_seller_status) {
    out.reputation = initRep;
  }
  return out;
}

/** Mescla enrich no objeto normalizado de persistência + extras de meta. */
export function applyEnrichedRawToNormalized(
  normalized,
  enrichedRaw,
  sourceStrategy,
  initialExtras = {},
  enrichDebug = null
) {
  const base = { ...(normalized && typeof normalized === "object" ? normalized : {}) };
  const init = initialExtras && typeof initialExtras === "object" ? initialExtras : {};
  let extras = {
    sales_hint: init.sales_hint ?? null,
    shipping: init.shipping && typeof init.shipping === "object" ? init.shipping : {},
    listing_type: init.listing_type ?? null,
    reputation: init.reputation && typeof init.reputation === "object" ? init.reputation : {},
  };
  if (!enrichedRaw) {
    if (!base.competitor_store_name && init.payload_store_name) {
      base.competitor_store_name = init.payload_store_name;
    }
    const statusUpdate = resolveListingStatusPersistUpdate(null, enrichDebug);
    if (statusUpdate.mode === "set") {
      if (
        hasPersistedLiveCommercialData(base) &&
        statusUpdate.status &&
        ML_LISTING_STATUS_INFERIDO_POR_HTTP.has(statusUpdate.status)
      ) {
        // Mantém status anterior quando enrich falhou mas há dados comerciais persistidos.
      } else {
        base.competitor_listing_status = statusUpdate.status;
      }
    }
    return { normalized: base, enrichExtras: extras, enrichOk: false };
  }

  const { patch: enrichPatch, sales_hint } = competitorPatchFromEnrichedRaw(enrichedRaw, sourceStrategy || "ml_link");
  const discovered = normalizeDiscoveredCompetitor(enrichedRaw, sourceStrategy || "ml_link");
  extras.sales_hint = mergeSalesHintPreserve(extras, discovered, enrichedRaw, sales_hint);
  extras.shipping =
    discovered.shipping && Object.keys(discovered.shipping).length ? discovered.shipping : extras.shipping;
  extras.listing_type = discovered.listing_type ?? extras.listing_type;
  extras.reputation =
    discovered.reputation && Object.keys(discovered.reputation).length ? discovered.reputation : extras.reputation;
  extras.competitor_pictures = normalizeCompetitorPictureUrls(
    enrichedRaw?.competitor_pictures,
    enrichPatch.competitor_thumbnail ?? base.competitor_thumbnail
  );

  const merged = {
    ...base,
    competitor_title: enrichPatch.competitor_title ?? base.competitor_title,
    competitor_seller_id: enrichPatch.competitor_seller_id ?? base.competitor_seller_id,
    competitor_store_name:
      enrichPatch.competitor_store_name ?? base.competitor_store_name ?? init.payload_store_name ?? null,
    competitor_permalink: enrichPatch.competitor_permalink ?? base.competitor_permalink,
    competitor_thumbnail: enrichPatch.competitor_thumbnail ?? base.competitor_thumbnail,
    last_seen_price: enrichPatch.last_seen_price ?? base.last_seen_price,
    last_seen_currency: enrichPatch.last_seen_currency ?? base.last_seen_currency,
  };

  extras = mergeInitialEnrichExtras(extras, init);

  const statusUpdate = resolveListingStatusPersistUpdate(enrichedRaw, enrichDebug);
  if (statusUpdate.mode === "set") {
    merged.competitor_listing_status = statusUpdate.status;
  } else if (statusUpdate.mode === "clear") {
    merged.competitor_listing_status = null;
  }

  const enrichOk = Boolean(
    merged.competitor_thumbnail || merged.last_seen_price != null || merged.competitor_store_name
  );
  return { normalized: merged, enrichExtras: extras, enrichOk };
}

/**
 * Enrich obrigatório antes de persistir quando faltam campos críticos.
 * Retry sem timeout curto se a primeira tentativa estourar o limite.
 */
export async function enrichCompetitorForPersist(accessToken, normalized, opts = {}) {
  const listingId = normalized?.competitor_listing_id;
  const sourceStrategy = opts.sourceStrategy || normalized?.source_strategy || "ml_link";
  const initialExtras = opts.initialExtras && typeof opts.initialExtras === "object" ? opts.initialExtras : {};
  const missingBefore = listMissingCriticalPersistFields(normalized);
  if (missingBefore.length) {
    console.info("[S7_COMPETITION_ENRICH_MISSING_FIELDS]", {
      listing_id: listingId,
      missing: missingBefore,
      source_strategy: sourceStrategy,
    });
  }

  const enrichDebug = {};
  const runEnrich = () =>
    enrichCompetitorListing(accessToken, {
      listingId: String(listingId),
      permalink: normalized.competitor_permalink ?? null,
      titleHint: normalized.competitor_title ?? null,
      fastDailyRefresh: opts.fastDailyRefresh === true,
      debug: enrichDebug,
    });

  let enrichOut = null;
  let enrichError = null;
  const timeoutMs = opts.forceFullEnrich || missingBefore.length > 0 ? 45000 : 25000;

  try {
    enrichOut = await enrichWithTimeout(runEnrich, timeoutMs);
  } catch (e) {
    enrichError = e?.message ?? String(e);
    if (enrichError === "enrich_timeout" && missingBefore.length > 0) {
      console.warn("[S7_COMPETITION_ENRICH] retry full enrich after timeout", { listing_id: listingId });
      try {
        enrichOut = await runEnrich();
        enrichError = null;
      } catch (e2) {
        enrichError = e2?.message ?? String(e2);
      }
    }
  }

  const enrichedRaw = enrichOut?.raw ?? null;
  const applied = applyEnrichedRawToNormalized(
    normalized,
    enrichedRaw,
    sourceStrategy,
    initialExtras,
    enrichDebug
  );
  const metaMissing = listMissingCriticalMetaFields(applied.enrichExtras);

  let directItemAudit = null;
  let salesHintResolution = null;
  const skipSalesAudit = opts.skipSalesAudit === true;
  const skipSalesResolver = opts.skipSalesResolver === true;

  if (accessToken && listingId && !skipSalesAudit) {
    console.info("[S7_COMPETITION_ENRICH_AUDIT_PATH]", {
      listing_id: listingId,
      has_access_token: Boolean(accessToken),
      audit_enabled: competitionSalesAuditEnabled(),
      trigger: "save_enrich",
      at: new Date().toISOString(),
    });
    try {
      directItemAudit = await runDirectItemSoldQuantityAudit({
        accessToken,
        item_id: String(listingId),
        connected_seller_id: opts.connected_seller_id ?? null,
        own_listing_id: opts.own_listing_id ?? null,
        trigger: "save_enrich",
      });
      applied.enrichExtras = applySalesHintResolutionToExtras(applied.enrichExtras, directItemAudit.resolution);
      if (directItemAudit.resolution.sales_hint != null) {
        applied.enrichOk = isEnrichResultComplete(applied.normalized, applied.enrichExtras);
      }
      logSalesPipelineTrace("after_direct_item_audit", {
        item_id: listingId,
        sales_hint: applied.enrichExtras?.sales_hint ?? null,
        sales_hint_source: applied.enrichExtras?.sales_hint_source ?? null,
        sales_hint_confidence: applied.enrichExtras?.sales_hint_confidence ?? null,
        ml_resolved: directItemAudit.hit != null,
        ml_diagnosis: directItemAudit.diagnosis ?? null,
      });
    } catch (e) {
      console.warn("[S7_COMPETITION_DIRECT_ITEM_AUDIT] enrich_skip", {
        listing_id: listingId,
        message: e?.message ?? String(e),
      });
    }
  }

  const currentSales = Number(applied.enrichExtras?.sales_hint);
  if (
    !(Number.isFinite(currentSales) && currentSales > 0) &&
    accessToken &&
    listingId &&
    !skipSalesResolver
  ) {
    try {
      const resolution = await resolveCompetitionSalesHint({
        accessToken,
        item_id: String(listingId),
        permalink: applied.normalized?.competitor_permalink ?? normalized?.competitor_permalink ?? null,
        catalog_product_id: opts.catalog_product_id ?? null,
        marketplace_account_id: opts.marketplace_account_id ?? normalized?.marketplace_account_id ?? null,
        connected_seller_id: opts.connected_seller_id ?? null,
        own_listing_id: opts.own_listing_id ?? null,
        skip_cache: true,
        skip_direct_audit: true,
      });
      salesHintResolution = resolution;
      applied.enrichExtras = applySalesHintResolutionToExtras(applied.enrichExtras, resolution);
      if (resolution.sales_hint != null) {
        applied.enrichOk = isEnrichResultComplete(applied.normalized, applied.enrichExtras);
      }
      logSalesPipelineTrace("after_resolver", {
        item_id: listingId,
        sales_hint: applied.enrichExtras?.sales_hint ?? null,
        sales_hint_source: applied.enrichExtras?.sales_hint_source ?? null,
        sales_hint_confidence: applied.enrichExtras?.sales_hint_confidence ?? null,
        resolver_diagnostics: resolution.diagnostics ?? null,
      });
    } catch (e) {
      console.warn("[S7_COMPETITION_SALES_HINT_RESOLVER] enrich_skip", {
        listing_id: listingId,
        message: e?.message ?? String(e),
      });
    }
  }

  console.info("[S7_COMPETITION_ENRICH_RESULT]", {
    listing_id: listingId,
    enrich_ok: applied.enrichOk,
    source_used: enrichOut?.enrichSource ?? null,
    fields_found: enrichOut?.fieldsFound ?? [],
    fields_missing: enrichOut?.fieldsMissing ?? [],
    meta_missing: metaMissing,
    error: enrichError,
    sales_hint: applied.enrichExtras?.sales_hint ?? null,
    sales_hint_source: applied.enrichExtras?.sales_hint_source ?? null,
  });

  return {
    ...applied,
    enrichError,
    enrichedRaw,
    enrichOut,
    enrichDebug,
    metaMissing,
    directItemAudit,
    salesHintResolution,
    complete: isEnrichResultComplete(applied.normalized, applied.enrichExtras),
  };
}

/** Log do contrato final antes de gravar no banco. */
export function logSaveContract(listingId, patch, enrichExtras, enrichOk) {
  console.info("[S7_COMPETITION_SAVE_CONTRACT]", {
    listing_id: listingId,
    enrich_ok: enrichOk,
    ...summarizeEnrichRawForLog({
      competitor_title: patch.competitor_title,
      competitor_price: patch.last_seen_price,
      competitor_thumbnail: patch.competitor_thumbnail,
      competitor_seller_id: patch.competitor_seller_id,
      competitor_store_name: patch.competitor_store_name,
      competitor_permalink: patch.competitor_permalink,
      listing_type: enrichExtras?.listing_type,
      shipping: enrichExtras?.shipping,
      sales_hint: enrichExtras?.sales_hint,
      reputation: enrichExtras?.reputation,
    }),
  });
}

/** Log do contrato mesclado no GET (row + snapshot). */
export function logGetMergedContract(competitor) {
  console.info("[S7_COMPETITION_GET_MERGED_CONTRACT]", {
    listing_id: competitor.competitor_listing_id,
    title: competitor.competitor_title ?? null,
    price: competitor.last_seen_price ?? null,
    thumbnail: competitor.competitor_thumbnail ? "yes" : null,
    store: competitor.competitor_store_name ?? null,
    sales_hint: competitor.sales_hint ?? null,
    free_shipping: competitor.shipping?.free_shipping === true ? true : null,
    listing_type: competitor.listing_type ?? null,
    reputation: competitor.reputation?.power_seller_status ?? competitor.reputation?.level_id ?? null,
    last_captured_at: competitor.last_captured_at ?? null,
  });
}
