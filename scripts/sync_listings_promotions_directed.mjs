#!/usr/bin/env node
/**
 * Sync direcionado — promoções + preço efetivo + health para homologação da Lista.
 * Uso:
 *   node scripts/sync_listings_promotions_directed.mjs MLB6086602390 MLB6784329822
 *   node scripts/sync_listings_promotions_directed.mjs --user-id <uuid>
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.local"), override: true });

const { getValidMLToken } = await import("../src/handlers/ml/_helpers/mlToken.js");
const { ML_MARKETPLACE_SLUG } = await import("../src/handlers/ml/_helpers/mlMarketplace.js");
const {
  fetchItem,
  fetchSellerPromotionsByItemDetailed,
  fetchSellerPromotionItemsForListing,
  enrichItemWithListingPricesFees,
} = await import("../src/handlers/ml/_helpers/mercadoLibreItemsApi.js");
const { enrichOfficialSellerPromotionRowsFromApi } = await import(
  "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js"
);
const { upsertMarketplaceListingHealthFromMlItem } = await import(
  "../src/handlers/ml/_helpers/mlListingHealthPersist.js"
);
const { extractOfficialMercadoLibreListingPricesFee } = await import(
  "../src/handlers/ml/_helpers/mlItemMoneyExtract.js"
);
const { fetchAllListingHealthRowsCompat } = await import(
  "../src/handlers/ml/_helpers/mlHealthSchemaCompat.js"
);
const { buildPricingCurrentStateProjectedUnitFromEngine } = await import(
  "../src/domain/pricing/buildPricingCurrentStateProjectedUnitFromEngine.js"
);
const { persistPricingCurrentStateReadModel } = await import(
  "../src/domain/pricing/listingPricingCurrentStateReadModel.js"
);

/**
 * @param {unknown} v
 */
function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Enriquece linhas started com listing_prices no preço promocional (Premium).
 * Persiste amount_to_receive / fee_discount para paridade offline da lista.
 * @param {string} accessToken
 * @param {Record<string, unknown>} liveItem
 * @param {Record<string, unknown>[]} promoRows
 * @param {Record<string, unknown>} enrichedBaseItem
 */
async function enrichStartedPromotionFinancialRows(accessToken, liveItem, promoRows, enrichedBaseItem) {
  const shipPersist = enrichedBaseItem?._suse7_shipping_options_free_persist;
  const shipAmt =
    toNum(shipPersist?.cost) ??
    toNum(shipPersist?.amount) ??
    toNum(shipPersist?.list_cost) ??
    null;

  for (const row of promoRows) {
    if (String(row.status ?? "").toLowerCase() !== "started") continue;
    const promoPrice = toNum(row.price);
    if (promoPrice == null || promoPrice <= 0) continue;

    try {
      const itemAtPromo = {
        ...liveItem,
        price: promoPrice,
        original_price: toNum(row.original_price) ?? toNum(liveItem.original_price) ?? toNum(liveItem.base_price),
        base_price: toNum(row.original_price) ?? toNum(liveItem.base_price) ?? toNum(liveItem.original_price),
      };
      const enrichedPromo = await enrichItemWithListingPricesFees(accessToken, itemAtPromo, {
        healthSync: true,
        preservarPrecoCenarioSimulacao: true,
      });
      const lp = enrichedPromo?._suse7_listing_prices_row_persist;
      if (lp != null && typeof lp === "object") {
        row._suse7_listing_prices_row_persist = lp;
      }
      const feePack = lp != null ? extractOfficialMercadoLibreListingPricesFee(/** @type {Record<string, unknown>} */ (lp)) : null;
      const grossFee =
        toNum(enrichedPromo.sale_fee_amount) ??
        toNum(feePack?.amount) ??
        toNum(enrichedPromo.sale_fee_details?.gross_amount);
      const netFee =
        toNum(enrichedPromo.sale_fee_details?.net_amount) ??
        toNum(enrichedPromo.sale_fee_details?.amount) ??
        grossFee;
      if (grossFee != null && netFee != null && grossFee > netFee) {
        row.original_fee_amount = grossFee;
        row.final_fee_amount = netFee;
        row.fee_discount_amount = Number((grossFee - netFee).toFixed(2));
      }
      if (shipAmt != null && netFee != null) {
        row.amount_to_receive = Number((promoPrice - netFee - shipAmt).toFixed(2));
      }
    } catch (e) {
      console.warn("[S7_SYNC_PROMO_DIRECTED] started_promo_financial_enrich_failed", {
        promotion_id: row.id ?? row.promotion_id ?? null,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

const argv = process.argv.slice(2);
const userIdArgIdx = argv.indexOf("--user-id");
const userIdValue =
  userIdArgIdx >= 0 && argv[userIdArgIdx + 1] ? String(argv[userIdArgIdx + 1]).trim() : null;
const USER_ID = userIdValue ?? "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";

const listingIds = argv.filter((a) => !a.startsWith("--") && a !== userIdValue);
const DEFAULT_IDS = ["MLB6086602390", "MLB6784329822"];
const TARGETS = listingIds.length > 0 ? listingIds : DEFAULT_IDS;

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[S7_SYNC_PROMO_DIRECTED] missing SUPABASE env");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * @param {string} externalListingId
 */
async function syncOneListing(externalListingId) {
  const ext = String(externalListingId).trim();
  const { data: listing, error: listingErr } = await sb
    .from("marketplace_listings")
    .select("id, external_listing_id, user_id, marketplace, marketplace_account_id, raw_json, price")
    .eq("user_id", USER_ID)
    .eq("external_listing_id", ext)
    .maybeSingle();

  if (listingErr) throw listingErr;
  if (!listing?.id) {
    console.warn("[S7_SYNC_PROMO_DIRECTED] listing_not_found", { external_listing_id: ext, user_id: USER_ID });
    return { external_listing_id: ext, ok: false, reason: "listing_not_found" };
  }

  const marketplaceAccountId =
    listing.marketplace_account_id != null ? String(listing.marketplace_account_id).trim() : null;

  let accessToken;
  try {
    accessToken = await getValidMLToken(USER_ID, {
      marketplaceAccountId: marketplaceAccountId ?? undefined,
    });
  } catch (e) {
    return {
      external_listing_id: ext,
      ok: false,
      reason: "ml_token_error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const liveItem = await fetchItem(accessToken, ext);
  if (!liveItem || typeof liveItem !== "object") {
    return { external_listing_id: ext, ok: false, reason: "fetch_item_failed" };
  }

  const promoFetch = await fetchSellerPromotionsByItemDetailed(accessToken, ext);
  let promoRows = promoFetch.rows ?? [];
  if (promoRows.length > 0) {
    promoRows = await enrichOfficialSellerPromotionRowsFromApi(
      accessToken,
      ext,
      promoRows,
      fetchSellerPromotionItemsForListing,
    );
  }

  const enrichedBase = await enrichItemWithListingPricesFees(accessToken, liveItem, {
    healthSync: true,
  });
  await enrichStartedPromotionFinancialRows(accessToken, liveItem, promoRows, enrichedBase);

  /** @type {Record<string, unknown>} */
  const itemForPersist = {
    .../** @type {Record<string, unknown>} */ (liveItem),
    ...enrichedBase,
    _suse7_item_promotions: promoRows,
  };

  const enriched = itemForPersist;

  const healthOk = await upsertMarketplaceListingHealthFromMlItem(sb, USER_ID, enriched, {
    accessToken,
    marketplace: listing.marketplace ?? ML_MARKETPLACE_SLUG,
    marketplaceAccountId,
    healthSyncExistingPass: true,
    financialSnapshot: { reason: "directed_promotion_sync", source: "sync_listings_promotions_directed" },
    log: (msg, extra) => console.info("[S7_SYNC_PROMO_DIRECTED][health]", msg, extra ?? {}),
  });

  const prevRaw =
    listing.raw_json != null && typeof listing.raw_json === "object" && !Array.isArray(listing.raw_json)
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : {};
  const nextRaw = {
    ...prevRaw,
    .../** @type {Record<string, unknown>} */ (enriched),
    _suse7_item_promotions: promoRows,
    _suse7_promotions_synced_at: new Date().toISOString(),
  };

  const { error: patchErr } = await sb
    .from("marketplace_listings")
    .update({
      raw_json: nextRaw,
      price: enriched.price ?? listing.price ?? null,
      base_price: enriched.base_price ?? null,
      original_price: enriched.original_price ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listing.id);

  if (patchErr) {
    return {
      external_listing_id: ext,
      ok: false,
      reason: "listing_raw_json_patch_failed",
      message: patchErr.message,
      health_ok: healthOk,
    };
  }

  /** Persiste read-model pricing_current_state para leitura rápida da lista (local_only). */
  let readModelOk = false;
  let readModelPreview = null;
  try {
    const { data: listingFresh, error: listingFreshErr } = await sb
      .from("marketplace_listings")
      .select("*")
      .eq("id", listing.id)
      .maybeSingle();
    if (listingFreshErr) throw listingFreshErr;
    if (!listingFresh) throw new Error("listing_not_found_after_patch");

    const { data: healthRows } = await fetchAllListingHealthRowsCompat(sb, USER_ID);
    const health = healthRows?.find((h) => String(h.external_listing_id ?? "") === ext) ?? null;

    const gridRow = {
      id: listingFresh.id,
      external_listing_id: ext,
      marketplace: listingFresh.marketplace,
      marketplace_account_id: listingFresh.marketplace_account_id,
      listing_type_id: listingFresh.listing_type_id,
      listing_type_label:
        String(listingFresh.listing_type_id ?? "").toLowerCase() === "gold_pro" ? "Premium" : "Clássico",
      sku: listingFresh.seller_sku ?? null,
    };

    const contract = await buildPricingCurrentStateProjectedUnitFromEngine({
      supabase: sb,
      userId: USER_ID,
      gridRow,
      listing: listingFresh,
      health,
      localOnly: true,
    });

    await persistPricingCurrentStateReadModel(sb, USER_ID, String(listingFresh.id), contract, {
      source: "sync_listings_promotions_directed",
    });

    readModelOk = true;
    readModelPreview = {
      current_effective_price_brl: contract.current_effective_price_brl ?? null,
      row_projected_profit_brl: contract.row_projected_profit_brl ?? null,
      row_projected_profit_percent: contract.row_projected_profit_percent ?? null,
    };
  } catch (readModelErr) {
    console.warn("[S7_SYNC_PROMO_DIRECTED] read_model_persist_failed", {
      external_listing_id: ext,
      message: readModelErr instanceof Error ? readModelErr.message : String(readModelErr),
    });
  }

  const started = promoRows.filter((r) => String(r?.status ?? "").toLowerCase() === "started");
  return {
    external_listing_id: ext,
    ok: healthOk,
    health_ok: healthOk,
    read_model_ok: readModelOk,
    read_model_preview: readModelPreview,
    promotions_total: promoRows.length,
    promotions_started: started.length,
    started_preview: started.slice(0, 3).map((r) => ({
      id: r.id ?? r.promotion_id ?? null,
      name: r.name ?? r.promotion_name ?? null,
      status: r.status ?? null,
      price: r.price ?? null,
    })),
  };
}

console.info("[S7_SYNC_PROMO_DIRECTED] start", { user_id: USER_ID, targets: TARGETS });

/** @type {Record<string, unknown>[]} */
const results = [];
for (const ext of TARGETS) {
  try {
    const result = await syncOneListing(ext);
    results.push(result);
    console.info("[S7_SYNC_PROMO_DIRECTED] done", result);
  } catch (e) {
    const fail = {
      external_listing_id: ext,
      ok: false,
      reason: "exception",
      message: e instanceof Error ? e.message : String(e),
    };
    results.push(fail);
    console.error("[S7_SYNC_PROMO_DIRECTED] error", fail);
  }
}

console.info("[S7_SYNC_PROMO_DIRECTED] summary", { results });
process.exit(results.every((r) => r.ok === true) ? 0 : 1);
