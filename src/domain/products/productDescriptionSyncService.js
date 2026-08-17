// ======================================================================

// Serviço — sincronização de descrição do produto para anúncios vinculados

// ======================================================================



import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";

import { extractMlPictureHttpFromObject } from "../../handlers/ml/_helpers/mercadoLibreListingCoverImage.js";

import { MLB_DESCRIPTION_MAX_LENGTH } from "../marketplaces/descriptionSync/MarketplaceDescriptionSyncStrategy.js";

import { MercadoLivreDescriptionSyncStrategy } from "../marketplaces/descriptionSync/MercadoLivreDescriptionSyncStrategy.js";

import { resolveMarketplaceDescriptionSyncStrategy } from "../marketplaces/descriptionSync/resolveMarketplaceDescriptionSyncStrategy.js";

import {

  fetchListingOfficialSalesCounts,

  pickOfficialSalesCount,

} from "./fetchListingOfficialSalesCounts.js";

import { resolveListingDisplayPriceFields } from "./resolveListingDisplayPrice.js";



const LISTING_CONCURRENCY = 2;

const UNSUPPORTED_MARKETPLACE_REASON =

  "Marketplace ainda não suportado para sincronização de descrição.";



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

    currentDescription: null,

    salesCountLocal,

  };

}



/**

 * @param {unknown} description

 */

function normalizarDescricaoParaSync(description) {

  const value = String(description ?? "");

  return value.trim() ? value : "";

}



/**

 * @param {unknown} row

 */

function contarCaracteresDescricao(row) {

  if (!row || typeof row !== "object") return 0;

  const plain = row.plain_text != null ? String(row.plain_text) : "";

  const html = row.html_text != null ? String(row.html_text) : "";

  const text = plain.trim() !== "" ? plain : html;

  return text.length;

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {string} productId

 */

export async function listProductDescriptionSyncCandidates(supabase, userId, productId) {

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



  const listingIds = (rows || []).map((r) => String(r.id)).filter(Boolean);

  /** @type {Map<string, Record<string, unknown>>} */

  const descByListingId = new Map();

  if (listingIds.length > 0) {

    const { data: descRows, error: descErr } = await supabase

      .from("marketplace_listing_descriptions")

      .select("listing_id, plain_text, html_text")

      .in("listing_id", listingIds);

    if (!descErr && Array.isArray(descRows)) {

      for (const row of descRows) {

        if (row?.listing_id) descByListingId.set(String(row.listing_id), row);

      }

    }

  }



  const extIds = (rows || [])

    .map((r) => textoOuNull(r.external_listing_id))

    .filter(Boolean);



  let officialSalesByCanonical = new Map();

  try {

    officialSalesByCanonical = await fetchListingOfficialSalesCounts(supabase, userId, extIds);

  } catch (salesErr) {

    console.warn("[product-description-sync] official_sales_fetch_failed", salesErr?.message ?? salesErr);

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

    const descRow = descByListingId.get(String(r.id)) ?? null;

    const descriptionCharsCount = contarCaracteresDescricao(descRow);



    const context = buildListingContext(r, officialSalesCount);

    const strategy = resolveMarketplaceDescriptionSyncStrategy(context.marketplace);

    const eligibility = strategy

      ? strategy.canUpdateDescription(context)

      : {

          canUpdateDescription: false,

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

      official_sales_count: officialSalesCount,

      status: textoOuNull(r.status) ?? textoOuNull(raw.status),

      listing_thumbnail: thumbUrl,

      description_chars_count: descriptionCharsCount,

      can_update_description: eligibility.canUpdateDescription === true,

      blocked_reason: eligibility.canUpdateDescription

        ? null

        : (eligibility.reason ?? UNSUPPORTED_MARKETPLACE_REASON),

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

  const runners = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {

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

 * @param {string} plainText

 * @param {Record<string, unknown> | null | undefined} rawDescription

 */

async function atualizarDescricaoLocalListing(supabase, userId, listingId, plainText, rawDescription) {

  const nowIso = new Date().toISOString();

  const { error } = await supabase.from("marketplace_listing_descriptions").upsert(

    {

      user_id: userId,

      listing_id: listingId,

      plain_text: plainText,

      html_text: null,

      raw_json: rawDescription && typeof rawDescription === "object" ? rawDescription : { plain_text: plainText },

      updated_at: nowIso,

    },

    { onConflict: "listing_id" },

  );

  if (error) {

    throw new Error(error.message || "Erro ao atualizar descrição local.");

  }

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {string} productId

 * @param {{

 *   description: string;

 *   listingIds: string[];

 *   syncMarketplace?: boolean;

 * }} input

 */

export async function syncProductDescriptionToListings(supabase, userId, productId, input) {

  const pid = textoOuNull(productId);

  const descriptionNorm = normalizarDescricaoParaSync(input.description);

  const listingIds = Array.isArray(input.listingIds)

    ? input.listingIds.map((id) => textoOuNull(id)).filter(Boolean)

    : [];

  const syncMarketplace = input.syncMarketplace !== false;



  if (!pid) return { ok: false, error: "product_id inválido" };

  if (!descriptionNorm) return { ok: false, error: "Descrição não pode ser vazia." };

  if (descriptionNorm.length > MLB_DESCRIPTION_MAX_LENGTH) {

    return {

      ok: false,

      error: `Descrição excede o limite de ${MLB_DESCRIPTION_MAX_LENGTH} caracteres permitido para sincronização.`,

    };

  }

  if (listingIds.length === 0) return { ok: false, error: "Selecione ao menos um anúncio." };



  const descriptionValidation = MercadoLivreDescriptionSyncStrategy.validateDescription(descriptionNorm);

  if (!descriptionValidation.valid) {

    return { ok: false, error: descriptionValidation.reason ?? "Descrição inválida." };

  }



  const { data: owns, error: ownErr } = await supabase

    .from("products")

    .select("id")

    .eq("id", pid)

    .eq("user_id", userId)

    .maybeSingle();

  if (ownErr) return { ok: false, error: ownErr.message };

  if (!owns) return { ok: false, error: "Produto não encontrado." };



  const { data: listingRows, error: listErr } = await supabase

    .from("marketplace_listings")

    .select("id, marketplace, marketplace_account_id, external_listing_id, status, raw_json, product_id")

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

    const context = buildListingContext(listing, 0);

    const strategy = resolveMarketplaceDescriptionSyncStrategy(marketplace);



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



    const eligibility = strategy.canUpdateDescription(context);

    if (!eligibility.canUpdateDescription) {

      blocked += 1;

      results.push({

        listing_id: listingId,

        external_listing_id: externalListingId,

        marketplace,

        status: "blocked",

        reason: eligibility.reason ?? UNSUPPORTED_MARKETPLACE_REASON,

      });

      return;

    }



    if (!syncMarketplace) {

      try {

        await atualizarDescricaoLocalListing(supabase, userId, listingId, descriptionNorm, null);

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



    const syncResult = await strategy.updateListingDescription(accessToken, context, descriptionNorm);

    if (!syncResult.ok) {

      failed += 1;

      results.push({

        listing_id: listingId,

        external_listing_id: externalListingId,

        marketplace,

        status: "failed",

        reason: syncResult.errorMessage ?? "Falha ao sincronizar descrição no marketplace.",

      });

      return;

    }



    try {

      await atualizarDescricaoLocalListing(

        supabase,

        userId,

        listingId,

        descriptionNorm,

        syncResult.rawDescription ?? null,

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

        reason: error instanceof Error ? error.message : "Erro ao atualizar descrição local após sync.",

      });

    }

  });



  return {

    ok: true,

    success: failed === 0 && blocked === 0,

    summary: {

      description_selected: 1,

      listings_selected: listingIds.length,

      synced,

      blocked,

      failed,

    },

    results,

  };

}

