// ======================================================
// Backfill — pricing_current_state_projected_unit (read-model da Lista).
// Engine PI offline (localOnly); não chama ML em massa na rota GET.
// ======================================================

import { buildPricingCurrentStateProjectedUnitFromEngine } from "./buildPricingCurrentStateProjectedUnitFromEngine.js";
import {
  persistPricingCurrentStateReadModel,
  readPricingCurrentStateReadModelFromListing,
} from "./listingPricingCurrentStateReadModel.js";
import { fetchAllListingHealthRowsCompat } from "../../handlers/ml/_helpers/mlHealthSchemaCompat.js";
import {
  getListingGridRow,
  putListingGridRowAliases,
} from "../../handlers/ml/_helpers/listingGridJoinKeys.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LIMIT = 500;
const MAX_CONCURRENCY = 16;
const MAX_LIMIT = 5000;

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
function parsePositiveInt(raw, fallback) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {unknown} raw
 * @param {boolean} fallback
 */
function parseBool(raw, fallback) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return fallback;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseListingIds(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(raw)
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * @param {Record<string, unknown>} listing
 */
function isActiveListingRow(listing) {
  const status = String(listing.status ?? "active")
    .trim()
    .toLowerCase();
  return status === "active" || status === "";
}

/**
 * @param {Record<string, unknown>} listing
 */
function resolveListingSku(listing) {
  const sku =
    listing.product_sku != null && String(listing.product_sku).trim() !== ""
      ? String(listing.product_sku).trim()
      : listing.seller_sku != null && String(listing.seller_sku).trim() !== ""
        ? String(listing.seller_sku).trim()
        : null;
  return sku;
}

/**
 * @param {Record<string, unknown>} listing
 * @returns {{ flags: string[]; incomplete: boolean }}
 */
function resolveCatalogCompletenessFlags(listing) {
  /** @type {string[]} */
  const flags = [];
  const sku = resolveListingSku(listing);
  if (sku == null) flags.push("sku_missing");

  const productCostRow =
    listing.product_cost_row != null && typeof listing.product_cost_row === "object"
      ? /** @type {Record<string, unknown>} */ (listing.product_cost_row)
      : null;
  const costPrice = productCostRow?.cost_price ?? listing.cost_price ?? null;
  if (costPrice == null || String(costPrice).trim() === "") {
    flags.push("product_cost_missing");
  }

  const completeness = String(listing.product_catalog_completeness ?? "").trim().toLowerCase();
  if (completeness !== "" && completeness !== "complete" && completeness !== "completo") {
    flags.push("catalog_incomplete");
  }

  if (listing.product_id == null && sku == null) {
    flags.push("product_link_missing");
  }

  return {
    flags,
    incomplete: flags.length > 0,
  };
}

/**
 * @param {Record<string, unknown>} listing
 */
function buildBackfillGridRow(listing) {
  const listingTypeId = String(listing.listing_type_id ?? "").toLowerCase();
  return {
    id: listing.id,
    external_listing_id: listing.external_listing_id,
    marketplace: listing.marketplace,
    marketplace_account_id: listing.marketplace_account_id,
    listing_type_id: listing.listing_type_id,
    listing_type_label: listingTypeId === "gold_pro" ? "Premium" : "Clássico",
    sku: resolveListingSku(listing),
    product_id: listing.product_id ?? null,
    effective_sale_price_brl: listing.price ?? listing.effective_sale_price_brl ?? null,
    listing_sale_price_brl: listing.price ?? listing.base_price ?? null,
    listing_price_brl: listing.price ?? null,
    promotion_active: false,
  };
}

/**
 * @param {Record<string, unknown>} contract
 * @param {string[]} extraFlags
 */
function mergeMissingDataFlags(contract, extraFlags) {
  const base = Array.isArray(contract.missing_data_flags)
    ? /** @type {string[]} */ (contract.missing_data_flags)
    : [];
  const merged = [...new Set([...base, ...extraFlags])];
  return { ...contract, missing_data_flags: merged };
}

/**
 * @param {Record<string, unknown>[]} listings
 * @param {Map<string, Record<string, unknown>>} healthByKey
 */
function attachProductFieldsFromJoin(listings, healthByKey) {
  for (const listing of listings) {
    const { products: prodRel, ...rest } = listing;
    const pr =
      prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
        ? /** @type {Record<string, unknown>} */ (prodRel)
        : Array.isArray(prodRel) && prodRel[0] && typeof prodRel[0] === "object"
          ? /** @type {Record<string, unknown>} */ (prodRel[0])
          : null;
    Object.assign(listing, rest);
    listing.product_sku =
      pr != null && pr.sku != null && String(pr.sku).trim() !== "" ? String(pr.sku).trim() : listing.product_sku ?? null;
    listing.product_cost_row =
      pr != null
        ? {
            cost_price: pr.cost_price,
            operational_cost: pr.operational_cost,
            packaging_cost: pr.packaging_cost,
          }
        : listing.product_cost_row ?? null;
    listing.product_catalog_completeness =
      pr?.catalog_completeness != null ? String(pr.catalog_completeness) : listing.product_catalog_completeness ?? null;
    if (healthByKey.size > 0 && listing.external_listing_id != null) {
      listing._health_row = getListingGridRow(healthByKey, listing.marketplace, listing.external_listing_id);
    }
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 */
async function runWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) return;
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    }),
  );
}

/**
 * @param {{
 *   seller_id?: string | null;
 *   sellerId?: string | null;
 *   user_id?: string | null;
 *   userId?: string | null;
 *   account_id?: string | null;
 *   accountId?: string | null;
 *   listing_ids?: string[] | string | null;
 *   listingIds?: string[] | string | null;
 *   only_missing?: boolean | string | null;
 *   onlyMissing?: boolean | string | null;
 *   force_recalculate?: boolean | string | null;
 *   forceRecalculate?: boolean | string | null;
 *   concurrency?: number | string | null;
 *   limit?: number | string | null;
 * }} raw
 */
export function normalizePricingCurrentStateBackfillInput(raw = {}) {
  const sellerId = String(
    raw.seller_id ?? raw.sellerId ?? raw.user_id ?? raw.userId ?? "",
  ).trim();
  const accountId = String(raw.account_id ?? raw.accountId ?? "").trim() || null;
  const listingIds = parseListingIds(raw.listing_ids ?? raw.listingIds ?? null);
  const onlyMissing = parseBool(raw.only_missing ?? raw.onlyMissing, true);
  const forceRecalculate = parseBool(raw.force_recalculate ?? raw.forceRecalculate, false);
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    parsePositiveInt(raw.concurrency, DEFAULT_CONCURRENCY),
  );
  const limit = Math.min(MAX_LIMIT, parsePositiveInt(raw.limit, DEFAULT_LIMIT));
  return {
    sellerId,
    accountId,
    listingIds,
    onlyMissing: forceRecalculate ? false : onlyMissing,
    forceRecalculate,
    concurrency,
    limit,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {ReturnType<typeof normalizePricingCurrentStateBackfillInput>} input
 */
export async function runPricingCurrentStateBackfillBatch(supabase, input) {
  const startedMs = Date.now();
  if (!input.sellerId) {
    throw new Error("seller_id_required");
  }

  const LISTINGS_SELECT =
    "id, title, marketplace, marketplace_account_id, price, base_price, original_price, status, external_listing_id, listing_type_id, raw_json, product_id, seller_sku, products(catalog_completeness, sku, cost_price, operational_cost, packaging_cost)";

  let query = supabase.from("marketplace_listings").select(LISTINGS_SELECT).eq("user_id", input.sellerId);
  if (input.accountId) {
    query = query.eq("marketplace_account_id", input.accountId);
  }
  if (input.listingIds.length > 0) {
    const externalIds = input.listingIds.filter((id) => /^MLB/i.test(id));
    const uuidIds = input.listingIds.filter((id) => !/^MLB/i.test(id));
    if (externalIds.length > 0 && uuidIds.length === 0) {
      query = query.in("external_listing_id", externalIds);
    } else if (uuidIds.length > 0 && externalIds.length === 0) {
      query = query.in("id", uuidIds);
    }
  }

  const { data: rows, error: listingsErr } = await query.order("updated_at", { ascending: false });
  if (listingsErr) throw listingsErr;

  const { data: healthRows } = await fetchAllListingHealthRowsCompat(supabase, input.sellerId);
  /** @type {Map<string, Record<string, unknown>>} */
  const healthByKey = new Map();
  for (const h of healthRows ?? []) {
    putListingGridRowAliases(healthByKey, h.marketplace, h, (r) => r.external_listing_id);
  }

  /** @type {Record<string, unknown>[]} */
  let listings = (rows ?? []).map((row) => ({ ...row }));
  attachProductFieldsFromJoin(listings, healthByKey);

  if (input.listingIds.length > 0) {
    const wanted = new Set(input.listingIds.map((id) => id.trim()));
    listings = listings.filter((listing) => {
      const ext = listing.external_listing_id != null ? String(listing.external_listing_id).trim() : "";
      const id = listing.id != null ? String(listing.id).trim() : "";
      return wanted.has(ext) || wanted.has(id);
    });
  }

  listings = listings.filter(isActiveListingRow);

  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  for (const listing of listings) {
    const hasReadModel = readPricingCurrentStateReadModelFromListing(listing) != null;
    if (input.onlyMissing && hasReadModel) continue;
    candidates.push(listing);
    if (candidates.length >= input.limit) break;
  }

  console.info("[S7_PRICING_CURRENT_STATE_BACKFILL_START]", {
    seller_id: input.sellerId,
    account_id: input.accountId,
    total_candidates: candidates.length,
    only_missing: input.onlyMissing,
    force_recalculate: input.forceRecalculate,
    concurrency: input.concurrency,
    limit: input.limit,
    listings_loaded: listings.length,
  });

  let okTotal = 0;
  let skippedTotal = 0;
  let errorTotal = 0;

  await runWithConcurrency(candidates, input.concurrency, async (listing) => {
    const externalId =
      listing.external_listing_id != null ? String(listing.external_listing_id).trim() : "";
    const sku = resolveListingSku(listing);
    const listingUuid = listing.id != null ? String(listing.id) : "";

    if (externalId === "") {
      skippedTotal += 1;
      console.info("[S7_PRICING_CURRENT_STATE_BACKFILL_ROW_SKIP]", {
        listing_id: listingUuid || null,
        sku,
        reason: "missing_external_listing_id",
        missing_data_flags: ["missing_external_listing_id"],
      });
      return;
    }

    if (!isActiveListingRow(listing)) {
      skippedTotal += 1;
      console.info("[S7_PRICING_CURRENT_STATE_BACKFILL_ROW_SKIP]", {
        listing_id: externalId,
        sku,
        reason: "listing_inactive",
        missing_data_flags: ["listing_inactive"],
      });
      return;
    }

    const catalog = resolveCatalogCompletenessFlags(listing);
    const health =
      listing._health_row ??
      getListingGridRow(healthByKey, listing.marketplace, listing.external_listing_id);
    const gridRow = buildBackfillGridRow(listing);

    try {
      let contract = await buildPricingCurrentStateProjectedUnitFromEngine({
        supabase,
        userId: input.sellerId,
        gridRow,
        listing,
        health: health ?? null,
        localOnly: true,
      });

      contract = mergeMissingDataFlags(contract, catalog.flags);
      contract = {
        ...contract,
        external_listing_id: contract.external_listing_id ?? externalId,
        sku: contract.sku ?? sku,
        account_id: contract.account_id ?? listing.marketplace_account_id ?? null,
      };

      const persisted = await persistPricingCurrentStateReadModel(
        supabase,
        input.sellerId,
        listingUuid,
        contract,
        { source: "pricing_current_state_backfill" },
      );

      okTotal += 1;
      console.info("[S7_PRICING_CURRENT_STATE_BACKFILL_ROW_OK]", {
        listing_id: externalId,
        sku,
        current_effective_price_brl: persisted.current_effective_price_brl ?? null,
        selected_promotion_name: persisted.selected_promotion_name ?? null,
        row_projected_profit_brl: persisted.row_projected_profit_brl ?? null,
        row_projected_profit_percent: persisted.row_projected_profit_percent ?? null,
        calculated_at: persisted.calculated_at ?? null,
      });
    } catch (err) {
      errorTotal += 1;
      console.info("[S7_PRICING_CURRENT_STATE_BACKFILL_ROW_ERROR]", {
        listing_id: externalId || listingUuid || null,
        sku,
        error_name: err instanceof Error ? err.name : "Error",
        error_message: err instanceof Error ? err.message : String(err),
        fallback_used: false,
      });
    }
  });

  const durationMs = Date.now() - startedMs;
  const processedTotal = okTotal + skippedTotal + errorTotal;

  console.info("[S7_PRICING_CURRENT_STATE_BACKFILL_DONE]", {
    processed_total: processedTotal,
    ok_total: okTotal,
    skipped_total: skippedTotal,
    error_total: errorTotal,
    duration_ms: durationMs,
  });

  return {
    seller_id: input.sellerId,
    account_id: input.accountId,
    total_candidates: candidates.length,
    processed_total: processedTotal,
    ok_total: okTotal,
    skipped_total: skippedTotal,
    error_total: errorTotal,
    only_missing: input.onlyMissing,
    force_recalculate: input.forceRecalculate,
    concurrency: input.concurrency,
    limit: input.limit,
    duration_ms: durationMs,
  };
}
