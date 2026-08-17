// ======================================================
// S1.PROMO-SSOT-FRESHNESS-AUDIT — origem e freshness por promoção (Modal PI)
// Compara live ML vs snapshot DB vs contract backend vs valores UI.
// ======================================================

import crypto from "node:crypto";
import Decimal from "decimal.js";
import {
  buildOfficialSellerPromotionIdentityKey,
  buildPromotionCardContract,
  enrichOfficialSellerPromotionRowsFromApi,
  extractOfficialPromotionFinancialRawFields,
  normalizeOfficialSellerPromotionsFromApi,
  resolvePromotionUiFinancials,
} from "./mercadoLivreOfficialSellerPromotions.js";
import {
  classifyPromotionPriceFamily,
  PROMOTION_PRICE_RESOLVER_VERSION,
} from "./mercadoLivrePromotionPriceResolverRegistry.js";
import { buildMercadoLivreListingPricingScenariosPayload } from "./mercadoLivreListingPricingScenarios.js";
import {
  loadMercadoLivreListingPricingInputs,
  loadMercadoLivreListingPricingInputsByExternalId,
} from "../../handlers/pricing/_helpers/mercadoLivrePricingSimulation.js";
import {
  fetchSellerPromotionItemsForListing,
  fetchSellerPromotionsByItemDetailed,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";

const ROUND = Decimal.ROUND_HALF_UP;
const PRICE_TOL = new Decimal("0.02");
const STALE_DB_MS = 5 * 60 * 1000;

/** @param {unknown} v @returns {Decimal | null} */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} a @param {Decimal | null} b */
function pricesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.minus(b).abs().lte(PRICE_TOL);
}

/** @param {unknown} value */
function stableJsonStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (value)).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJsonStringify(/** @type {Record<string, unknown>} */ (value)[k])}`)
    .join(",")}}`;
}

/** @param {unknown} value @returns {string | null} */
function hashPayload(value) {
  if (value == null) return null;
  return crypto.createHash("sha256").update(stableJsonStringify(value)).digest("hex").slice(0, 16);
}

/** @param {Record<string, unknown>} row */
export function normalizePromotionRowForFreshnessHash(row) {
  const fin = extractOfficialPromotionFinancialRawFields(row);
  return {
    id: row.id ?? row.promotion_id ?? null,
    offer_id: row.ref_id ?? row.offer_id ?? null,
    type: row.type ?? row.promotion_type ?? null,
    name: row.name ?? row.promotion_name ?? null,
    status: row.status ?? null,
    original_price: row.original_price ?? row.regular_amount ?? null,
    price: row.price ?? row.amount ?? row.deal_price ?? null,
    suggested_discounted_price: row.suggested_discounted_price ?? null,
    max_discounted_price: row.max_discounted_price ?? null,
    min_discounted_price: row.min_discounted_price ?? null,
    top_deal_price: row.top_deal_price ?? null,
    total_price_for_boosted_offer: row.total_price_for_boosted_offer ?? null,
    boosted_offer: row.boosted_offer ?? null,
    _suse7_price_enriched: row._suse7_price_enriched ?? null,
    financial_keys: fin,
  };
}

/** @param {Record<string, unknown> | null | undefined} contract */
function normalizeContractForFreshnessHash(contract) {
  if (contract == null || typeof contract !== "object") return null;
  return {
    promotion_id: contract.promotion_id ?? null,
    promotion_name: contract.promotion_name ?? null,
    original_price_brl: contract.original_price_brl ?? null,
    real_promotion_final_price_brl:
      contract.real_promotion_final_price_brl ??
      contract.buyer_final_price_brl ??
      contract.final_price_brl ??
      null,
    final_price_source: contract.final_price_source ?? null,
    discount_amount_brl: contract.discount_amount_brl ?? null,
    discount_percent_display: contract.discount_percent_display ?? null,
  };
}

/**
 * @param {Record<string, unknown>} listing
 * @returns {Record<string, unknown>[]}
 */
export function extractDbSnapshotPromotionRows(listing) {
  const raw =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;
  const promos = raw?._suse7_item_promotions;
  if (!Array.isArray(promos)) return [];
  return promos.filter((p) => p != null && typeof p === "object").map((p) => ({ ...p }));
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {Map<string, Record<string, unknown>>}
 */
function mapRowsByIdentity(rows) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = buildOfficialSellerPromotionIdentityKey(row);
    if (key.replace(/\|/g, "") !== "") map.set(key, row);
    const pid = row.id ?? row.promotion_id;
    if (pid != null && String(pid).trim() !== "") {
      map.set(`pid:${String(pid).trim()}`, row);
    }
  }
  return map;
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @param {Map<string, Record<string, unknown>>} map
 * @param {string | null | undefined} promotionId
 */
function lookupPromotionRow(row, map, promotionId) {
  if (row != null && typeof row === "object") {
    const key = buildOfficialSellerPromotionIdentityKey(row);
    if (map.has(key)) return map.get(key) ?? null;
  }
  if (promotionId != null && String(promotionId).trim() !== "") {
    const pidKey = `pid:${String(promotionId).trim()}`;
    if (map.has(pidKey)) return map.get(pidKey) ?? null;
  }
  return null;
}

/**
 * @param {{
 *   pipelinePromoSource?: string | null;
 *   liveFetchOk?: boolean;
 *   rawRow?: Record<string, unknown> | null;
 *   cardContract?: Record<string, unknown> | null;
 * }} ctx
 */
function buildSourceTrace(ctx) {
  /** @type {string[]} */
  const trace = [];
  if (ctx.liveFetchOk === true) trace.push("pipeline:live_seller_promotions_fetch");
  else if (ctx.pipelinePromoSource === "db_snapshot") trace.push("pipeline:db_snapshot_fallback");
  else trace.push("pipeline:persisted_read_model");

  const raw = ctx.rawRow;
  if (raw?._suse7_price_enriched === true) trace.push("enrichment:promotion_items");
  const source = ctx.cardContract?.final_price_source;
  if (source != null && String(source).trim() !== "") {
    trace.push(`resolver:${String(source)}`);
  }
  return trace;
}

/** @param {string | null | undefined} source */
function sourcePriority(source) {
  const s = source != null ? String(source).toLowerCase() : "";
  if (s.includes("live") || s === "live_api" || s === "ml_seller_promotions_live") return 1;
  if (s.includes("db") || s === "persisted" || s === "db_snapshot") return 2;
  if (s.includes("read_model") || s.includes("prices")) return 3;
  if (s.includes("health")) return 4;
  return 5;
}

/**
 * @param {{
 *   listingExternalId?: string | null;
 *   listingUuid?: string | null;
 *   sellerId?: string | null;
 *   marketplaceAccountId?: string | null;
 *   promotionId?: string | null;
 *   promotionName?: string | null;
 *   promotionFamily?: string | null;
 *   cardContract?: Record<string, unknown> | null;
 *   rawRowUsed?: Record<string, unknown> | null;
 *   liveRow?: Record<string, unknown> | null;
 *   dbRow?: Record<string, unknown> | null;
 *   freshnessCtx?: Record<string, unknown> | null;
 *   liveUi?: ReturnType<typeof resolvePromotionUiFinancials> | null;
 * }} params
 */
export function buildPiPromotionSsotFreshnessAuditEntry(params) {
  const freshnessCtx = params.freshnessCtx ?? {};
  const cardContract = params.cardContract ?? null;
  const rawRowUsed = params.rawRowUsed ?? null;

  const uiFinalPrice =
    cardContract?.real_promotion_final_price_brl ??
    cardContract?.buyer_final_price_brl ??
    cardContract?.final_price_brl ??
    null;
  const uiDiscountAmount = cardContract?.discount_amount_brl ?? null;
  const uiDiscountPercent = cardContract?.discount_percent_display ?? null;

  const selectedSource = cardContract?.final_price_source ?? null;
  const pipelineSource =
    freshnessCtx.pipeline_promo_source != null ? String(freshnessCtx.pipeline_promo_source) : null;
  const liveFetchOk = freshnessCtx.live_fetch_ok === true;
  const cacheHit = freshnessCtx.cache_hit === true;
  const cacheLayer =
    freshnessCtx.cache_layer != null ? String(freshnessCtx.cache_layer) : liveFetchOk ? "none" : "db";

  const liveHash = params.liveRow ? hashPayload(normalizePromotionRowForFreshnessHash(params.liveRow)) : null;
  const dbHash = params.dbRow ? hashPayload(normalizePromotionRowForFreshnessHash(params.dbRow)) : null;
  const contractHash = hashPayload(normalizeContractForFreshnessHash(cardContract));

  const mlLiveFetchedAt =
    freshnessCtx.ml_live_fetched_at != null ? String(freshnessCtx.ml_live_fetched_at) : null;
  const dbSnapshotUpdatedAt =
    freshnessCtx.db_snapshot_updated_at != null ? String(freshnessCtx.db_snapshot_updated_at) : null;
  const promotionSnapshotCapturedAt =
    freshnessCtx.promotion_snapshot_captured_at != null
      ? String(freshnessCtx.promotion_snapshot_captured_at)
      : dbSnapshotUpdatedAt;
  const backendContractGeneratedAt = new Date().toISOString();
  const frontendReceivedAt =
    cardContract?.frontend_received_at != null ? String(cardContract.frontend_received_at) : null;

  /** @type {string[]} */
  const warnings = [];

  if (dbSnapshotUpdatedAt && mlLiveFetchedAt) {
    const dbMs = Date.parse(dbSnapshotUpdatedAt);
    const liveMs = Date.parse(mlLiveFetchedAt);
    if (Number.isFinite(dbMs) && Number.isFinite(liveMs) && liveMs - dbMs > STALE_DB_MS) {
      if (cacheHit || pipelineSource === "db_snapshot") {
        warnings.push("stale_db_snapshot");
      }
    }
  }

  if (liveHash && dbHash && liveHash !== dbHash) {
    warnings.push("live_payload_differs_from_db");
  }

  const siblingRows = Array.isArray(freshnessCtx.same_listing_promotion_rows)
    ? /** @type {Record<string, unknown>[]} */ (freshnessCtx.same_listing_promotion_rows)
    : [];
  const comparisonRow = rawRowUsed ?? params.liveRow ?? null;
  const sourceUi =
    comparisonRow != null
      ? resolvePromotionUiFinancials(comparisonRow, {
          skipLiquidaCaseAudit: true,
          sameListingSiblingRows: siblingRows,
          sameListingOtherPromotionPrices: siblingRows
            .filter((other) => other !== comparisonRow)
            .map((other) => {
              const otherUi = resolvePromotionUiFinancials(other, { skipLiquidaCaseAudit: true });
              return otherUi.final_price_brl;
            })
            .filter(Boolean),
        })
      : params.liveUi ??
        (params.liveRow ? resolvePromotionUiFinancials(params.liveRow, { skipLiquidaCaseAudit: true }) : null);

  const liveUi = sourceUi;
  const liveFinalDec = toDec(liveUi?.final_price_brl);
  const contractFinalDec = toDec(uiFinalPrice);
  if (liveFinalDec != null && contractFinalDec != null && !pricesEqual(liveFinalDec, contractFinalDec)) {
    warnings.push("modal_contract_differs_from_live");
  }

  if (frontendReceivedAt && mlLiveFetchedAt) {
    const feMs = Date.parse(frontendReceivedAt);
    const liveMs = Date.parse(mlLiveFetchedAt);
    if (Number.isFinite(feMs) && Number.isFinite(liveMs) && feMs < liveMs - STALE_DB_MS) {
      warnings.push("frontend_possible_cache");
    }
  }

  const variationAudit =
    cardContract?.variation_linkage_v1 != null && typeof cardContract.variation_linkage_v1 === "object"
      ? /** @type {Record<string, unknown>} */ (cardContract.variation_linkage_v1)
      : null;
  const sourceWarnings = Array.isArray(cardContract?.source_warnings)
    ? /** @type {string[]} */ (cardContract.source_warnings)
    : [];
  if (
    variationAudit?.has_price_range === true ||
    sourceWarnings.includes("promotion_price_range_detected") ||
    sourceWarnings.includes("variation_range_ambiguous_single_price_selected")
  ) {
    warnings.push("variation_range_detected");
  }
  if (
    sourceWarnings.includes("variation_range_ambiguous_single_price_selected") ||
    sourceWarnings.includes("silent_single_price_selected")
  ) {
    warnings.push("ambiguous_single_price_selected");
  }

  const family =
    params.promotionFamily ??
    (rawRowUsed ? classifyPromotionPriceFamily(rawRowUsed) : null) ??
    (params.liveRow ? classifyPromotionPriceFamily(params.liveRow) : null);

  return {
    listing_id: params.listingExternalId ?? params.listingUuid ?? null,
    seller_id: params.sellerId ?? null,
    marketplace_account_id: params.marketplaceAccountId ?? null,
    promotion_id: params.promotionId ?? cardContract?.promotion_id ?? null,
    promotion_name: params.promotionName ?? cardContract?.promotion_name ?? null,
    promotion_family: family,
    resolver_version: PROMOTION_PRICE_RESOLVER_VERSION,
    ui_final_price: uiFinalPrice,
    ui_discount_amount: uiDiscountAmount,
    ui_discount_percent: uiDiscountPercent,
    selected_source: pipelineSource ?? (liveFetchOk ? "live_api" : "db_snapshot"),
    selected_field: selectedSource,
    selected_source_priority: sourcePriority(pipelineSource ?? selectedSource),
    source_trace: buildSourceTrace({
      pipelinePromoSource: pipelineSource,
      liveFetchOk,
      rawRow: rawRowUsed,
      cardContract,
    }),
    ml_live_fetched_at: mlLiveFetchedAt,
    db_snapshot_updated_at: dbSnapshotUpdatedAt,
    promotion_snapshot_captured_at: promotionSnapshotCapturedAt,
    backend_contract_generated_at: backendContractGeneratedAt,
    frontend_received_at: frontendReceivedAt,
    cache_hit: cacheHit,
    cache_layer: cacheLayer,
    raw_payload_hash_live: liveHash,
    raw_payload_hash_db: dbHash,
    contract_hash: contractHash,
    warnings,
    pi_modal_uses: liveFetchOk && pipelineSource === "live_api" ? "live_api" : "db_snapshot",
    live_ui_final_price: liveUi?.final_price_brl ?? null,
    db_row_price:
      params.dbRow?.price ??
      params.dbRow?.suggested_discounted_price ??
      params.dbRow?.max_discounted_price ??
      null,
  };
}

/** @param {Record<string, unknown>} entry */
export function logS7PiPromotionSsotFreshnessAudit(entry) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PI_PROMOTION_SSOT_FRESHNESS_AUDIT]", entry);
}

/**
 * Monta audit ponta a ponta a partir de cenário PI já montado.
 * @param {{
 *   listingExternalId?: string | null;
 *   sellerId?: string | null;
 *   marketplaceAccountId?: string | null;
 *   row: Record<string, unknown>;
 *   rawRow?: Record<string, unknown> | null;
 *   freshnessCtx?: Record<string, unknown> | null;
 * }} ctx
 */
export function buildPiPromotionSsotFreshnessAuditFromScenario(ctx) {
  const cardContract =
    ctx.row.promotion_card_contract != null && typeof ctx.row.promotion_card_contract === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.row.promotion_card_contract)
      : null;
  const freshnessCtx = ctx.freshnessCtx ?? {};
  const dbMap =
    freshnessCtx.db_row_by_identity instanceof Map
      ? freshnessCtx.db_row_by_identity
      : new Map();
  const liveMap =
    freshnessCtx.live_row_by_identity instanceof Map
      ? freshnessCtx.live_row_by_identity
      : new Map();

  const promotionId =
    ctx.row.promotion_id != null
      ? String(ctx.row.promotion_id)
      : cardContract?.promotion_id != null
        ? String(cardContract.promotion_id)
        : null;
  const rawRow = ctx.rawRow ?? null;
  const liveRow = lookupPromotionRow(rawRow, liveMap, promotionId);
  const dbRow = lookupPromotionRow(rawRow, dbMap, promotionId);

  return buildPiPromotionSsotFreshnessAuditEntry({
    listingExternalId: ctx.listingExternalId,
    listingUuid: ctx.row.listing_id != null ? String(ctx.row.listing_id) : null,
    sellerId: ctx.sellerId,
    marketplaceAccountId: ctx.marketplaceAccountId,
    promotionId,
    promotionName:
      ctx.row.promotion_name != null
        ? String(ctx.row.promotion_name)
        : cardContract?.promotion_name != null
          ? String(cardContract.promotion_name)
          : null,
    cardContract,
    rawRowUsed: rawRow,
    liveRow,
    dbRow,
    freshnessCtx,
  });
}

/**
 * @param {ReturnType<typeof buildPiPromotionSsotFreshnessAuditEntry>[]} entries
 * @param {{ pipelineUsesLive?: boolean; liveFetchOk?: boolean }} ctx
 */
function buildListingFreshnessSummary(entries, ctx) {
  const pipelineUsesLive = ctx.pipelineUsesLive === true;
  const anyStale = entries.some((e) => e.warnings.includes("stale_db_snapshot"));
  const anyContractDiff = entries.some((e) => e.warnings.includes("modal_contract_differs_from_live"));
  const anyLiveDbDiff = entries.some((e) => e.warnings.includes("live_payload_differs_from_db"));

  /** @type {string | null} */
  let divergingLayer = null;
  for (const e of entries) {
    if (e.warnings.includes("modal_contract_differs_from_live")) {
      divergingLayer = "backend_contract_vs_live";
      break;
    }
    if (e.warnings.includes("live_payload_differs_from_db")) {
      divergingLayer = "db_snapshot_vs_live_ml";
      break;
    }
    if (e.warnings.includes("frontend_possible_cache")) {
      divergingLayer = "frontend_cache";
      break;
    }
    if (e.warnings.includes("stale_db_snapshot") && !pipelineUsesLive) {
      divergingLayer = "db_read_model";
      break;
    }
  }

  return {
    q1_pi_modal_source: pipelineUsesLive ? "live_api" : "db_snapshot",
    q2_data_is_fresh: pipelineUsesLive ? !anyContractDiff : !anyStale && !anyContractDiff,
    q3_contract_matches_source: !anyContractDiff,
    q4_live_differs_from_db: anyLiveDbDiff,
    q5_diverging_layer: divergingLayer,
    promotion_count: entries.length,
    warnings_total: entries.reduce((acc, e) => acc + e.warnings.length, 0),
  };
}

/**
 * Debug side-by-side — live ML, DB snapshot e contract PI.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   listingId?: string;
 *   listingExternalId?: string;
 *   forceFresh?: boolean;
 *   referenceZipCode?: string | null;
 * }} keys
 */
export async function buildMercadoLivreListingPromotionsFreshnessDebug(supabase, userId, keys) {
  const listingId = keys.listingId != null ? String(keys.listingId).trim() : "";
  const listingExternalId =
    keys.listingExternalId != null ? String(keys.listingExternalId).trim() : listingId;
  const forceFresh = keys.forceFresh !== false;

  let loaded;
  if (listingId && !listingId.toUpperCase().startsWith("MLB")) {
    loaded = await loadMercadoLivreListingPricingInputs(supabase, userId, listingId);
  } else {
    loaded = await loadMercadoLivreListingPricingInputsByExternalId(
      supabase,
      userId,
      listingExternalId
    );
  }

  if (!loaded.ok || !loaded.listing) {
    return { ok: false, error: loaded.error ?? "Falha ao carregar anúncio.", status: loaded.status ?? 500 };
  }

  const { listing, health } = loaded;
  const itemMlId =
    loaded.external_listing_id != null && String(loaded.external_listing_id).trim() !== ""
      ? String(loaded.external_listing_id).trim()
      : listing.external_listing_id != null
        ? String(listing.external_listing_id).trim()
        : listingExternalId;
  const marketplaceAccountId = loaded.marketplace_account_id ?? null;
  const sellerId = loaded.seller_id ?? null;

  const dbSnapshotRows = extractDbSnapshotPromotionRows(listing);
  const dbRowByIdentity = mapRowsByIdentity(dbSnapshotRows);

  const listingUpdatedAt =
    listing.updated_at != null ? String(listing.updated_at) : null;
  const healthUpdatedAt =
    health?.updated_at != null ? String(health.updated_at) : null;
  const dbSnapshotUpdatedAt = listingUpdatedAt ?? healthUpdatedAt;

  /** @type {Record<string, unknown>[]} */
  let liveRows = [];
  let liveFetchOk = false;
  let mlLiveFetchedAt = /** @type {string | null} */ (null);
  let liveFetchError = /** @type {string | null} */ (null);

  if (forceFresh) {
    let mlToken = null;
    try {
      mlToken = await getValidMLToken(userId, {
        marketplaceAccountId: marketplaceAccountId ?? undefined,
        mlUserId: sellerId ?? undefined,
      });
    } catch (e) {
      liveFetchError = e instanceof Error ? e.message : String(e);
    }

    if (mlToken && itemMlId) {
      try {
        const fetchResult = await fetchSellerPromotionsByItemDetailed(mlToken, itemMlId);
        liveFetchOk = fetchResult.ok;
        liveRows = fetchResult.rows ?? [];
        mlLiveFetchedAt = new Date().toISOString();
        if (!fetchResult.ok) {
          liveFetchError = fetchResult.error ?? `http_${fetchResult.httpStatus ?? "unknown"}`;
        }
        if (liveRows.length > 0) {
          liveRows = await enrichOfficialSellerPromotionRowsFromApi(
            mlToken,
            itemMlId,
            liveRows,
            fetchSellerPromotionItemsForListing
          );
        }
      } catch (e) {
        liveFetchError = e instanceof Error ? e.message : String(e);
      }
    } else if (!liveFetchError) {
      liveFetchError = "missing_access_token";
    }
  }

  const liveRowByIdentity = mapRowsByIdentity(liveRows);

  const refZip =
    keys.referenceZipCode != null && String(keys.referenceZipCode).trim() !== ""
      ? String(keys.referenceZipCode).trim()
      : "01310100";

  const piPayload = await buildMercadoLivreListingPricingScenariosPayload(supabase, userId, {
    listingExternalId: itemMlId,
    scenarioScope: "pricing_opportunities",
    referenceZipCode: refZip,
  });

  const promotionsPipeline =
    piPayload.ok === true && piPayload.data?.promotions_pipeline != null
      ? /** @type {Record<string, unknown>} */ (piPayload.data.promotions_pipeline)
      : null;
  const pipelineUsesLive =
    promotionsPipeline?.pipeline_promo_source === "live_api" &&
    promotionsPipeline?.live_fetch_ok === true;

  /** @type {ReturnType<typeof buildPiPromotionSsotFreshnessAuditEntry>[]} */
  const freshnessAudits = [];
  /** @type {Record<string, unknown>[]} */
  const promotionsSideBySide = [];

  const handlerPromos =
    piPayload.ok && Array.isArray(piPayload.data?.promotion_scenarios)
      ? piPayload.data.promotion_scenarios
      : [];

  for (const scenarioRow of handlerPromos) {
    if (!scenarioRow || typeof scenarioRow !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (scenarioRow);
    const cardContract =
      row.promotion_card_contract != null && typeof row.promotion_card_contract === "object"
        ? /** @type {Record<string, unknown>} */ (row.promotion_card_contract)
        : null;
    const promotionId =
      row.promotion_id != null
        ? String(row.promotion_id)
        : cardContract?.promotion_id != null
          ? String(cardContract.promotion_id)
          : null;

    const liveRow = lookupPromotionRow(null, liveRowByIdentity, promotionId);
    const dbRow = lookupPromotionRow(null, dbRowByIdentity, promotionId);

    const liveCardContract =
      liveRow != null
        ? buildPromotionCardContract({
            listingExternalId: itemMlId,
            marketplaceAccountId,
            promotionRow: liveRow,
            normalizedPromotion:
              normalizeOfficialSellerPromotionsFromApi([liveRow], { source: "live" }).promotions[0] ??
              {},
            sameListingPromotionRows: liveRows,
          })
        : null;

    const freshnessCtx = {
      ml_live_fetched_at: mlLiveFetchedAt,
      db_snapshot_updated_at: dbSnapshotUpdatedAt,
      promotion_snapshot_captured_at: dbSnapshotUpdatedAt,
      live_fetch_ok: pipelineUsesLive,
      pipeline_promo_source: pipelineUsesLive ? "live_api" : "db_snapshot",
      cache_hit: !pipelineUsesLive,
      cache_layer: pipelineUsesLive ? "none" : "db",
      db_row_by_identity: dbRowByIdentity,
      live_row_by_identity: liveRowByIdentity,
      same_listing_promotion_rows: liveRows,
    };

    const auditEntry = buildPiPromotionSsotFreshnessAuditEntry({
      listingExternalId: itemMlId,
      listingUuid: listing.id != null ? String(listing.id) : null,
      sellerId,
      marketplaceAccountId,
      promotionId,
      promotionName:
        row.promotion_name != null
          ? String(row.promotion_name)
          : cardContract?.promotion_name != null
            ? String(cardContract.promotion_name)
            : null,
      cardContract,
      rawRowUsed: liveRow ?? dbRow,
      liveRow,
      dbRow,
      freshnessCtx,
    });

    freshnessAudits.push(auditEntry);
    logS7PiPromotionSsotFreshnessAudit(auditEntry);

    promotionsSideBySide.push({
      promotion_id: promotionId,
      promotion_name: auditEntry.promotion_name,
      live_payload: liveRow ? normalizePromotionRowForFreshnessHash(liveRow) : null,
      db_snapshot: dbRow ? normalizePromotionRowForFreshnessHash(dbRow) : null,
      promotion_card_contract: cardContract,
      live_promotion_card_contract: liveCardContract,
      promotion_price_candidates: cardContract?.promotion_price_candidates ?? [],
      freshness_audit: auditEntry,
    });
  }

  const summary = buildListingFreshnessSummary(freshnessAudits, {
    pipelineUsesLive,
    liveFetchOk,
  });

  return {
    ok: true,
    listing_id: itemMlId,
    listing_uuid: listing.id != null ? String(listing.id) : null,
    seller_id: sellerId,
    marketplace_account_id: marketplaceAccountId,
    force_fresh: forceFresh,
    ml_live_fetched_at: mlLiveFetchedAt,
    live_fetch_ok: liveFetchOk,
    live_fetch_error: liveFetchError,
    db_snapshot_updated_at: dbSnapshotUpdatedAt,
    db_snapshot_row_count: dbSnapshotRows.length,
    live_row_count: liveRows.length,
    pi_pipeline: {
      ok: piPayload.ok === true,
      promotion_scenario_count: handlerPromos.length,
      uses_live_api: pipelineUsesLive,
      diagnostics: piPayload.ok ? piPayload.data?.diagnostics ?? null : null,
      error: piPayload.ok ? null : piPayload.error ?? null,
    },
    summary,
    promotions: promotionsSideBySide,
    freshness_audits: freshnessAudits,
    resolver_version: PROMOTION_PRICE_RESOLVER_VERSION,
  };
}
