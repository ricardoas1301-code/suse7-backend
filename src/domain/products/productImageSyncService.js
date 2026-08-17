// ======================================================================
// Serviço — sincronização de imagens do produto para anúncios vinculados
// ======================================================================

import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";
import { extractMlPictureHttpFromObject } from "../../handlers/ml/_helpers/mercadoLibreListingCoverImage.js";
import { PRODUCT_IMAGE_BANK_MAX } from "../marketplaces/imageSync/MarketplaceImageSyncStrategy.js";
import { resolveMarketplaceImageSyncStrategy } from "../marketplaces/imageSync/resolveMarketplaceImageSyncStrategy.js";

const BUCKET = "product-images";
const SIGNED_URL_TTL_SEC = 600;
const LISTING_CONCURRENCY = 2;

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 */
export async function listProductImageSyncCandidates(supabase, userId, productId) {
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
    "id, marketplace, marketplace_account_id, external_listing_id, title, seller_sku, seller_custom_field, status, price, permalink, raw_json, marketplace_accounts(account_alias, ml_nickname, logo_url, avatar_url)";
  const selectFallback =
    "id, marketplace, marketplace_account_id, external_listing_id, title, seller_sku, seller_custom_field, status, price, permalink, raw_json";

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
  let metricsRows = [];
  if (extIds.length > 0) {
    const { data, error: metricsErr } = await supabase
      .from("product_card_metrics")
      .select("external_listing_id, marketplace, qty_sold_total")
      .eq("user_id", userId)
      .in("external_listing_id", extIds);
    if (!metricsErr && Array.isArray(data)) metricsRows = data;
  }
  const salesByKey = new Map(
    metricsRows.map((m) => [
      `${String(m.marketplace)}::${String(m.external_listing_id)}`,
      Number(m.qty_sold_total) || 0,
    ]),
  );

  const listings = (rows || []).map((r) => {
    const raw =
      r.raw_json && typeof r.raw_json === "object" && !Array.isArray(r.raw_json)
        ? /** @type {Record<string, unknown>} */ (r.raw_json)
        : {};
    const pictures = Array.isArray(raw.pictures) ? raw.pictures : [];
    const thumbObj = pictures.find((p) => p && typeof p === "object");
    const thumbUrl = thumbObj ? extractMlPictureHttpFromObject(/** @type {Record<string, unknown>} */ (thumbObj)) : null;
    const accountJoin =
      r.marketplace_accounts && typeof r.marketplace_accounts === "object" ? r.marketplace_accounts : null;
    const accountLabel =
      textoOuNull(accountJoin?.ml_nickname) ??
      textoOuNull(accountJoin?.account_alias) ??
      null;
    const sku =
      textoOuNull(r.seller_custom_field) ?? textoOuNull(r.seller_sku) ?? null;
    const price = r.price != null ? Number(r.price) : null;
    const salesKey = `${String(r.marketplace)}::${String(r.external_listing_id)}`;
    const salesCount = salesByKey.get(salesKey) ?? (Number(raw.sold_quantity) || 0);

    return {
      listing_id: String(r.id),
      marketplace: textoOuNull(r.marketplace),
      marketplace_account_id: textoOuNull(r.marketplace_account_id),
      external_listing_id: textoOuNull(r.external_listing_id),
      title: textoOuNull(r.title),
      sku,
      account_label: accountLabel,
      price_brl: price != null && Number.isFinite(price) ? price.toFixed(2) : null,
      sales_count: Number.isFinite(salesCount) ? Math.max(0, Math.trunc(salesCount)) : 0,
      pictures_count: pictures.length,
      status: textoOuNull(r.status) ?? textoOuNull(raw.status),
      listing_thumbnail: thumbUrl,
    };
  });

  return { ok: true, listings };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} link
 */
async function resolveProductImagePublicUrl(supabase, link) {
  const rawPath = textoOuNull(link.storage_path);
  if (!rawPath) return null;
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rawPath, SIGNED_URL_TTL_SEC);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
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
 * @param {string} productId
 * @param {{
 *   imageLinkIds: string[];
 *   listingIds: string[];
 *   syncMarketplace?: boolean;
 * }} input
 */
export async function syncProductImagesToListings(supabase, userId, productId, input) {
  const pid = textoOuNull(productId);
  const imageLinkIds = Array.isArray(input.imageLinkIds)
    ? input.imageLinkIds.map((id) => textoOuNull(id)).filter(Boolean)
    : [];
  const listingIds = Array.isArray(input.listingIds)
    ? input.listingIds.map((id) => textoOuNull(id)).filter(Boolean)
    : [];
  const syncMarketplace = input.syncMarketplace !== false;

  if (!pid) return { ok: false, error: "product_id inválido" };
  if (imageLinkIds.length === 0) return { ok: false, error: "Selecione ao menos uma imagem." };
  if (listingIds.length === 0) return { ok: false, error: "Selecione ao menos um anúncio." };
  if (imageLinkIds.length > PRODUCT_IMAGE_BANK_MAX) {
    return { ok: false, error: `Selecione no máximo ${PRODUCT_IMAGE_BANK_MAX} imagens.` };
  }

  const { data: owns, error: ownErr } = await supabase
    .from("products")
    .select("id")
    .eq("id", pid)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownErr) return { ok: false, error: ownErr.message };
  if (!owns) return { ok: false, error: "Produto não encontrado." };

  const { data: imageRows, error: imgErr } = await supabase
    .from("product_image_links")
    .select("id, storage_path, sort_order, variant_key")
    .eq("user_id", userId)
    .eq("product_id", pid)
    .is("variant_key", null)
    .in("id", imageLinkIds);
  if (imgErr) return { ok: false, error: imgErr.message };
  if (!imageRows || imageRows.length !== imageLinkIds.length) {
    return { ok: false, error: "Uma ou mais imagens não pertencem a este produto." };
  }

  const orderedImages = [...imageRows].sort(
    (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0),
  );

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

  /** @type {import("../marketplaces/imageSync/MarketplaceImageSyncStrategy.js").ProductImageSyncAsset[]} */
  const assets = [];
  for (const row of orderedImages) {
    const url = await resolveProductImagePublicUrl(supabase, row);
    if (!url) {
      return { ok: false, error: "Não foi possível resolver URL pública de uma das imagens selecionadas." };
    }
    assets.push({
      id: String(row.id),
      url,
      sortOrder: Number(row.sort_order) || 0,
      marketplacePictureId: null,
    });
  }

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  let synced = 0;
  let failed = 0;

  await runWithConcurrency(listingRows, LISTING_CONCURRENCY, async (listing) => {
    const listingId = String(listing.id);
    const marketplace = textoOuNull(listing.marketplace) ?? "unknown";
    const externalListingId = textoOuNull(listing.external_listing_id);
    const rawJson =
      listing.raw_json && typeof listing.raw_json === "object" && !Array.isArray(listing.raw_json)
        ? /** @type {Record<string, unknown>} */ (listing.raw_json)
        : {};
    const hasVariations = Array.isArray(rawJson.variations) && rawJson.variations.length > 0;

    const strategy = resolveMarketplaceImageSyncStrategy(marketplace);
    if (!strategy) {
      failed += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "unsupported_marketplace",
        error_message: "Marketplace ainda não suportado para sincronização de imagens.",
      });
      return;
    }

    let accessToken = null;
    if (syncMarketplace) {
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
          status: "invalid_token",
          error_message: error instanceof Error ? error.message : "Token marketplace inválido.",
        });
        return;
      }
    }

    const limit = await strategy.getImageLimitForListing(
      {
        listingId,
        externalListingId: externalListingId ?? "",
        marketplaceAccountId: textoOuNull(listing.marketplace_account_id),
        marketplace,
        rawJson,
        hasVariations,
      },
      accessToken,
    );

    if (assets.length > limit.maxPictures) {
      failed += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "limit_exceeded",
        error_message: `Este anúncio permite até ${limit.maxPictures} imagens. Você selecionou ${assets.length}.`,
        max_pictures: limit.maxPictures,
        selected_pictures: assets.length,
        limit_source: limit.source,
      });
      return;
    }

    if (!syncMarketplace) {
      synced += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "synced_local",
        pictures_count: assets.length,
      });
      return;
    }

    try {
      const pictures = await strategy.uploadOrResolveImages(accessToken, assets);
      const syncResult = await strategy.replaceListingPictures(
        accessToken,
        {
          listingId,
          externalListingId: externalListingId ?? "",
          marketplaceAccountId: textoOuNull(listing.marketplace_account_id),
          marketplace,
          rawJson,
          hasVariations,
        },
        pictures,
      );

      const nowIso = new Date().toISOString();
      if (syncResult.ok) {
        synced += 1;
        const picturesPayload = pictures.map((p, idx) => ({
          id: p.id,
          secure_url: p.secure_url ?? p.url ?? null,
          url: p.url ?? p.secure_url ?? null,
          position: idx,
        }));
        const rawNext = {
          ...rawJson,
          pictures: picturesPayload,
        };
        await supabase
          .from("marketplace_listings")
          .update({ raw_json: rawNext, updated_at: nowIso })
          .eq("id", listingId)
          .eq("user_id", userId);

        const { error: syncSettingsErr } = await supabase.from("listing_image_sync_settings").upsert(
          {
            user_id: userId,
            product_id: pid,
            listing_id: listingId,
            marketplace,
            image_link_ids: imageLinkIds,
            marketplace_picture_ids: syncResult.marketplacePictureIds ?? pictures.map((p) => p.id),
            last_synced_at: nowIso,
            last_sync_status: "synced",
            last_error: null,
            updated_at: nowIso,
          },
          { onConflict: "listing_id" },
        );
        if (syncSettingsErr) {
          console.warn("[product-image-sync] listing_image_sync_settings_upsert_failed", syncSettingsErr.message);
        }

        results.push({
          listing_id: listingId,
          external_listing_id: externalListingId,
          marketplace,
          status: "synced",
          pictures_count: syncResult.picturesCount ?? pictures.length,
        });
      } else {
        failed += 1;
        const { error: syncSettingsFailErr } = await supabase.from("listing_image_sync_settings").upsert(
          {
            user_id: userId,
            product_id: pid,
            listing_id: listingId,
            marketplace,
            image_link_ids: imageLinkIds,
            marketplace_picture_ids: [],
            last_synced_at: nowIso,
            last_sync_status: syncResult.status,
            last_error: syncResult.errorMessage ?? "Falha ao sincronizar imagens.",
            updated_at: nowIso,
          },
          { onConflict: "listing_id" },
        );
        if (syncSettingsFailErr) {
          console.warn("[product-image-sync] listing_image_sync_settings_upsert_failed", syncSettingsFailErr.message);
        }
        results.push({
          listing_id: listingId,
          external_listing_id: externalListingId,
          marketplace,
          status: syncResult.errorCode ?? syncResult.status ?? "failed",
          error_message: syncResult.errorMessage ?? "Falha ao sincronizar imagens.",
        });
      }
    } catch (error) {
      failed += 1;
      results.push({
        listing_id: listingId,
        external_listing_id: externalListingId,
        marketplace,
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    ok: true,
    success: failed === 0,
    summary: {
      images_selected: imageLinkIds.length,
      listings_selected: listingIds.length,
      synced,
      failed,
    },
    results,
  };
}
