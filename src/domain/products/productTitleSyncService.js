// ======================================================================
// Serviço — sincronização de título do produto para anúncios vinculados
// ======================================================================

import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";
import { extractMlPictureHttpFromObject } from "../../handlers/ml/_helpers/mercadoLibreListingCoverImage.js";
import { normalizeTitle, normalizeTitleKey } from "../AdTitlesDomainService.js";
import { MLB_TITLE_MAX_LENGTH } from "../marketplaces/titleSync/MarketplaceTitleSyncStrategy.js";
import {
  ML_TITLE_SOLD_BLOCK_REASON,
  MercadoLivreTitleSyncStrategy,
} from "../marketplaces/titleSync/MercadoLivreTitleSyncStrategy.js";
import { resolveMarketplaceTitleSyncStrategy } from "../marketplaces/titleSync/resolveMarketplaceTitleSyncStrategy.js";
import {
  fetchListingOfficialSalesCounts,
  pickOfficialSalesCount,
} from "./fetchListingOfficialSalesCounts.js";
import { resolveListingDisplayPriceFields } from "./resolveListingDisplayPrice.js";

const LISTING_CONCURRENCY = 2;
const UNSUPPORTED_MARKETPLACE_REASON =
  "Marketplace ainda não suportado para sincronização de título.";
const AD_TITLE_DUPLICATE_MESSAGE =
  "Título já cadastrado. Crie uma variação diferente para este anúncio.";
const SINGLE_LISTING_SYNC_MESSAGE =
  "Selecione apenas um anúncio para sincronizar este título.";

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} salesCountLocal
 */
function buildListingContext(row, salesCountLocal) {
  const rawJson =
    row.raw_json && typeof row.raw_json === "object" && !Array.isArray(row.raw_json)
      ? /** @type {Record<string, unknown>} */ (row.raw_json)
      : {};
  return {
    listingId: String(row.id),
    externalListingId: textoOuNull(row.external_listing_id) ?? "",
    marketplaceAccountId: textoOuNull(row.marketplace_account_id),
    marketplace: textoOuNull(row.marketplace) ?? "unknown",
    rawJson,
    currentTitle: textoOuNull(row.title),
    salesCountLocal,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 */
export async function listProductTitleSyncCandidates(supabase, userId, productId) {
  const pid = textoOuNull(productId);
  if (!pid) return { ok: false, error: "product_id inválido", listings: [] };

  const { data: owns, error: ownErr } = await supabase
    .from("products")
    .select("id")
    .eq("id", pid)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownErr) return { ok: false, error: ownErr.message, listings: [] };
  if (!owns) return { ok: false, error: "Produto não encontrado", listings: [] };

  const selectWithAccount =
    "id, marketplace, marketplace_account_id, external_listing_id, title, seller_sku, seller_custom_field, status, price, original_price, base_price, permalink, raw_json, marketplace_accounts(account_alias, ml_nickname, logo_url, avatar_url)";
  const selectFallback =
    "id, marketplace, marketplace_account_id, external_listing_id, title, seller_sku, seller_custom_field, status, price, original_price, base_price, permalink, raw_json";

  let { data: rows, error: qErr } = await supabase
    .from("marketplace_listings")
    .select(selectWithAccount)
    .eq("user_id", userId)
    .eq("product_id", pid)
    .order("api_last_seen_at", { ascending: false });

  if (qErr) {
    const qMsg = String(qErr?.message ?? "").toLowerCase();
    if (qMsg.includes("marketplace_accounts") || String(qErr?.code ?? "") === "PGRST200") {
      ({ data: rows, error: qErr } = await supabase
        .from("marketplace_listings")
        .select(selectFallback)
        .eq("user_id", userId)
        .eq("product_id", pid)
        .order("api_last_seen_at", { ascending: false }));
    }
  }
  if (qErr) return { ok: false, error: qErr.message, listings: [] };

  const extIds = (rows || [])
    .map((r) => textoOuNull(r.external_listing_id))
    .filter(Boolean);

  let officialSalesByCanonical = new Map();
  try {
    officialSalesByCanonical = await fetchListingOfficialSalesCounts(supabase, userId, extIds);
  } catch (salesErr) {
    console.warn("[product-title-sync] official_sales_fetch_failed", salesErr?.message ?? salesErr);
  }

  let healthRows = [];
  if (extIds.length > 0) {
    const { data, error: healthErr } = await supabase
      .from("marketplace_listing_health")
      .select("marketplace, external_listing_id, promotion_price, raw_json")
      .eq("user_id", userId)
      .in("external_listing_id", extIds);
    if (!healthErr && Array.isArray(data)) healthRows = data;
  }
  const healthByKey = new Map(
    healthRows.map((h) => [`${String(h.marketplace)}::${String(h.external_listing_id)}`, h]),
  );

  const listings = (rows || []).map((r) => {
    const raw =
      r.raw_json && typeof r.raw_json === "object" && !Array.isArray(r.raw_json)
        ? /** @type {Record<string, unknown>} */ (r.raw_json)
        : {};
    const pictures = Array.isArray(raw.pictures) ? raw.pictures : [];
    const thumbObj = pictures.find((p) => p && typeof p === "object");
    const thumbUrl = thumbObj
      ? extractMlPictureHttpFromObject(/** @type {Record<string, unknown>} */ (thumbObj))
      : null;
    const accountJoin =
      r.marketplace_accounts && typeof r.marketplace_accounts === "object" ? r.marketplace_accounts : null;
    const accountLabel =
      textoOuNull(accountJoin?.ml_nickname) ?? textoOuNull(accountJoin?.account_alias) ?? null;
    const sku = textoOuNull(r.seller_custom_field) ?? textoOuNull(r.seller_sku) ?? null;
    const healthKey = `${String(r.marketplace)}::${String(r.external_listing_id)}`;
    const healthRow = healthByKey.get(healthKey) ?? null;
    const priceFields = resolveListingDisplayPriceFields(r, healthRow);
    const externalListingId = textoOuNull(r.external_listing_id);
    const officialSalesCount = pickOfficialSalesCount(externalListingId, officialSalesByCanonical);

    const context = buildListingContext(r, officialSalesCount);
    const strategy = resolveMarketplaceTitleSyncStrategy(context.marketplace);
    const eligibility = strategy
      ? strategy.canUpdateTitle(context)
      : {
          canUpdateTitle: false,
          reason: UNSUPPORTED_MARKETPLACE_REASON,
        };

    return {
      listing_id: String(r.id),
      marketplace: textoOuNull(r.marketplace),
      marketplace_account_id: textoOuNull(r.marketplace_account_id),
      external_listing_id: externalListingId,
      title: textoOuNull(r.title),
      sku,
      account_label: accountLabel,
      display_price_brl: priceFields.display_price_brl,
      regular_price_brl: priceFields.regular_price_brl,
      is_promotion_active: priceFields.is_promotion_active,
      /** @deprecated compat — usar display_price_brl */
      price_brl: priceFields.display_price_brl,
      official_sales_count: officialSalesCount,
      /** @deprecated compat — usar official_sales_count */
      sales_count: officialSalesCount,
      marketplace_sold_quantity: eligibility.soldQuantity ?? null,
      marketplace_sold_quantity_source: eligibility.soldQuantitySource ?? null,
      status: textoOuNull(r.status) ?? textoOuNull(raw.status),
      listing_thumbnail: thumbUrl,
      can_update_title: eligibility.canUpdateTitle === true,
      blocked_reason: eligibility.canUpdateTitle ? null : (eligibility.reason ?? UNSUPPORTED_MARKETPLACE_REASON),
    };
  });

  return { ok: true, listings };
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} worker
 */
async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {string} newTitle
 * @param {Record<string, unknown>} rawJson
 */
async function atualizarTituloLocalListing(supabase, userId, listingId, newTitle, rawJson) {
  const nowIso = new Date().toISOString();
  const rawNext = {
    ...rawJson,
    title: newTitle,
  };
  const { error } = await supabase
    .from("marketplace_listings")
    .update({
      title: newTitle,
      raw_json: rawNext,
      updated_at: nowIso,
    })
    .eq("id", listingId)
    .eq("user_id", userId);
  if (error) {
    throw new Error(error.message || "Erro ao atualizar título local.");
  }
}

/**
 * @param {unknown} adTitles
 */
function possuiTitulosDuplicadosNoProduto(adTitles) {
  const list = Array.isArray(adTitles) ? adTitles : [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of list) {
    const value = normalizeTitle(String(item?.value ?? item?.title ?? ""));
    if (!value) continue;
    const key = normalizeTitleKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) > 1) return true;
  }
  return false;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 * @param {{
 *   title: string;
 *   listingIds: string[];
 *   syncMarketplace?: boolean;
 * }} input
 */
export async function syncProductTitleToListings(supabase, userId, productId, input) {
  const pid = textoOuNull(productId);
  const titleNorm = normalizeTitle(input.title);
  const listingIds = Array.isArray(input.listingIds)
    ? input.listingIds.map((id) => textoOuNull(id)).filter(Boolean)
    : [];
  const syncMarketplace = input.syncMarketplace !== false;

  if (!pid) return { ok: false, error: "product_id inválido" };
  if (!titleNorm) return { ok: false, error: "Título não pode ser vazio." };
  if (titleNorm.length > MLB_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Título excede o limite de ${MLB_TITLE_MAX_LENGTH} caracteres permitido para sincronização.`,
    };
  }
  if (listingIds.length === 0) return { ok: false, error: "Selecione ao menos um anúncio." };
  if (listingIds.length > 1) return { ok: false, error: SINGLE_LISTING_SYNC_MESSAGE };

  const titleValidation = MercadoLivreTitleSyncStrategy.validateTitle(titleNorm);
  if (!titleValidation.valid) {
    return { ok: false, error: titleValidation.reason ?? "Título inválido." };
  }

  const { data: owns, error: ownErr } = await supabase
    .from("products")
    .select("id, ad_titles")
    .eq("id", pid)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownErr) return { ok: false, error: ownErr.message };
  if (!owns) return { ok: false, error: "Produto não encontrado." };

  if (possuiTitulosDuplicadosNoProduto(owns.ad_titles)) {
    return { ok: false, error: AD_TITLE_DUPLICATE_MESSAGE };
  }

  const { data: listingRows, error: listErr } = await supabase
    .from("marketplace_listings")
    .select("id, marketplace, marketplace_account_id, external_listing_id, status, raw_json, product_id, title")
    .eq("user_id", userId)
    .eq("product_id", pid)
    .in("id", listingIds);
  if (listErr) return { ok: false, error: listErr.message };
  if (!listingRows || listingRows.length !== listingIds.length) {
    return { ok: false, error: "Um ou mais anúncios não pertencem a este produto." };
  }

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  let synced = 0;
  let blocked = 0;
  let failed = 0;

  await runWithConcurrency(listingRows, LISTING_CONCURRENCY, async (listing) => {
    const listingId = String(listing.id);
    const marketplace = textoOuNull(listing.marketplace) ?? "unknown";
    const externalListingId = textoOuNull(listing.external_listing_id);
    const rawJson =
      listing.raw_json && typeof listing.raw_json === "object" && !Array.isArray(listing.raw_json)
        ? /** @type {Record<string, unknown>} */ (listing.raw_json)
        : {};

    const context = buildListingContext(listing, 0);
    const strategy = resolveMarketplaceTitleSyncStrategy(marketplace);

    if (!strategy) {
      blocked += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "blocked",
        reason: UNSUPPORTED_MARKETPLACE_REASON,
      });
      return;
    }

    const eligibility = strategy.canUpdateTitle(context);
    if (!eligibility.canUpdateTitle) {
      blocked += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "blocked",
        reason: eligibility.reason ?? ML_TITLE_SOLD_BLOCK_REASON,
        sold_quantity: eligibility.soldQuantity ?? null,
        sold_quantity_source: eligibility.soldQuantitySource ?? null,
      });
      return;
    }

    if (!syncMarketplace) {
      try {
        await atualizarTituloLocalListing(supabase, userId, listingId, titleNorm, rawJson);
        synced += 1;
        results.push({
          listing_id: listingId,
          external_listing_id: externalListingId,
          marketplace,
          status: "synced_local",
        });
      } catch (error) {
        failed += 1;
        results.push({
          listing_id: listingId,
          external_listing_id: externalListingId,
          marketplace,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    let accessToken = null;
    try {
      accessToken = await getValidMLToken(userId, {
        marketplaceAccountId: textoOuNull(listing.marketplace_account_id),
      });
    } catch (error) {
      failed += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "failed",
        reason: error instanceof Error ? error.message : "Token marketplace inválido.",
      });
      return;
    }

    const syncResult = await strategy.updateListingTitle(accessToken, context, titleNorm);
    if (!syncResult.ok) {
      failed += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "failed",
        reason: syncResult.errorMessage ?? "Falha ao sincronizar título no marketplace.",
      });
      return;
    }

    try {
      const rawNext =
        syncResult.rawItem && typeof syncResult.rawItem === "object"
          ? /** @type {Record<string, unknown>} */ (syncResult.rawItem)
          : { ...rawJson, title: titleNorm };
      await atualizarTituloLocalListing(
        supabase,
        userId,
        listingId,
        textoOuNull(rawNext.title) ?? titleNorm,
        rawNext,
      );
      synced += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "synced",
      });
    } catch (error) {
      failed += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "failed",
        reason: error instanceof Error ? error.message : "Erro ao atualizar título local após sync.",
      });
    }
  });

  return {
    ok: true,
    success: failed === 0 && blocked === 0,
    summary: {
      title_selected: 1,
      listings_selected: listingIds.length,
      synced,
      blocked,
      failed,
    },
    results,
  };
}
