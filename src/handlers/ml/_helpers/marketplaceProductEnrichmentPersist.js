// ======================================================================
// Persistência S1 — enriquecimento produto + product_image_links (service role).
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { normalizeMarketplaceProductData } from "../../../domain/marketplace/normalizeMarketplaceProductData.js";
import { pickPrimaryListingForSkuGroup } from "../../../domain/marketplace/pickPrimaryListingForSkuGroup.js";
import {
  buildMarketplaceProductEnrichmentPatch,
  shouldReplaceMarketplaceImageLinks,
} from "../../../domain/marketplace/mergeMarketplaceProductEnrichment.js";
import { ML_PRODUCT_IMPORT_MAX_IMAGES } from "../../../domain/marketplace/adapters/mercadoLivreProductDataAdapter.js";
import { normalizeProductPayload } from "../../../domain/ProductDomainService.js";
import { normalizeProductImagesForDb } from "../../../handlers/products/create.js";

export const ML_IMPORT_IMAGE_FILE_PREFIX = "ml-import:";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} listingId
 * @param {object | null} inlineDescription
 */
async function resolveListingDescriptionForEnrichment(supabase, listingId, inlineDescription) {
  if (inlineDescription && typeof inlineDescription === "object" && inlineDescription.plain_text != null) {
    return inlineDescription;
  }
  const { data, error } = await supabase
    .from("marketplace_listing_descriptions")
    .select("plain_text, html_text, raw_json")
    .eq("listing_id", listingId)
    .maybeSingle();
  if (error || !data) return inlineDescription;
  return {
    plain_text: data.plain_text,
    html_text: data.html_text,
    raw_json: data.raw_json,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 * @param {{ url: string; sort_order: number }[]} pictureUrls
 */
export async function syncProductImageLinksFromMarketplaceUrls(supabase, userId, productId, pictureUrls) {
  if (!productId || !Array.isArray(pictureUrls) || pictureUrls.length === 0) return { replaced: false };

  const { data: existing, error: listErr } = await supabase
    .from("product_image_links")
    .select("id, storage_path, file_name, variant_key, sort_order")
    .eq("product_id", productId)
    .eq("user_id", userId)
    .is("variant_key", null)
    .order("sort_order", { ascending: true });

  if (listErr) {
    console.error("[marketplace-product-enrichment] list_image_links_failed", listErr);
    return { replaced: false, error: listErr };
  }

  if (!shouldReplaceMarketplaceImageLinks(existing || [])) {
    return { replaced: false, skipped_manual: true };
  }

  const ids = (existing || []).map((r) => r.id).filter(Boolean);
  if (ids.length > 0) {
    const { error: delErr } = await supabase.from("product_image_links").delete().in("id", ids);
    if (delErr) {
      console.error("[marketplace-product-enrichment] delete_image_links_failed", delErr);
      return { replaced: false, error: delErr };
    }
  }

  const slice = pictureUrls.slice(0, ML_PRODUCT_IMPORT_MAX_IMAGES);
  const rows = slice.map((p, idx) => ({
    user_id: userId,
    product_id: productId,
    variant_key: null,
    storage_path: p.url,
    file_name: `${ML_IMPORT_IMAGE_FILE_PREFIX}${idx + 1}`,
    mime_type: "image/jpeg",
    sort_order: idx,
    is_primary: idx === 0,
  }));

  const { error: insErr } = await supabase.from("product_image_links").insert(rows);
  if (insErr) {
    console.error("[marketplace-product-enrichment] insert_image_links_failed", insErr);
    return { replaced: false, error: insErr };
  }

  return { replaced: true, count: rows.length };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 * @param {Record<string, unknown>} normalized
 */
export async function applyMarketplaceProductEnrichmentUpdate(supabase, userId, productId, normalized) {
  const { data: existing, error: loadErr } = await supabase
    .from("products")
    .select(
      "id, catalog_source, stock_source, product_name, description, brand, model, gtin, ncm, seo_keywords, ad_titles, product_images, stock_quantity, width, height, length, weight, assembled_width, assembled_height, assembled_length, assembled_weight, category_ml_id, marketplace_imported_at"
    )
    .eq("id", productId)
    .eq("user_id", userId)
    .maybeSingle();

  if (loadErr || !existing?.id) {
    return { ok: false, reason: loadErr ? "load_error" : "not_found" };
  }

  const patch = buildMarketplaceProductEnrichmentPatch(existing, normalized);
  const keys = Object.keys(patch).filter((k) => k !== "marketplace_last_synced_at");
  if (keys.length <= 1 && keys.every((k) => k === "marketplace_imported_at")) {
    // só timestamps
  }

  const { error: updErr } = await supabase
    .from("products")
    .update(patch)
    .eq("id", productId)
    .eq("user_id", userId);

  if (updErr) {
    console.error("[marketplace-product-enrichment] product_update_failed", updErr);
    return { ok: false, reason: "update_error", error: updErr };
  }

  const pictureUrls = Array.isArray(normalized.picture_urls) ? normalized.picture_urls : [];
  const img = await syncProductImageLinksFromMarketplaceUrls(supabase, userId, productId, pictureUrls);

  return { ok: true, patch_keys: Object.keys(patch), images: img };
}

/**
 * Agrupa entradas por SKU normalizado, escolhe anúncio principal e enriquece produtos.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Map<string, string>} productIdByNorm
 * @param {{ listingId: string; norm: string; resolvedSku: string; item: Record<string, unknown>; description: object | null; extId: string }[]} prepared
 */
export async function enrichProductsFromPreparedListingBatch(supabase, userId, productIdByNorm, prepared) {
  /** @type {Map<string, typeof prepared>} */
  const byNorm = new Map();
  for (let i = 0; i < prepared.length; i += 1) {
    const p = prepared[i];
    if (!byNorm.has(p.norm)) byNorm.set(p.norm, []);
    byNorm.get(p.norm).push({ ...p, importOrder: i });
  }

  const stats = {
    enriched: 0,
    skipped_no_product: 0,
    errors: /** @type {object[]} */ ([]),
  };

  for (const [norm, group] of byNorm) {
    const productId = productIdByNorm.get(norm);
    if (!productId) {
      stats.skipped_no_product += 1;
      continue;
    }

    const primary = pickPrimaryListingForSkuGroup(group);
    if (!primary) continue;

    const description = await resolveListingDescriptionForEnrichment(
      supabase,
      primary.listingId,
      primary.description
    );

    let normalized;
    try {
      normalized = normalizeMarketplaceProductData(
        ML_MARKETPLACE_SLUG,
        primary.item,
        description,
        null,
        { resolvedSku: primary.resolvedSku, externalListingId: primary.extId }
      );
    } catch (err) {
      stats.errors.push({ stage: "normalize", norm, message: err?.message });
      continue;
    }

    const draft = normalizeProductPayload({
      product_name: normalized.product_name,
      format: "simple",
      sku: normalized.sku,
      description: normalized.description,
      brand: normalized.brand,
      model: normalized.model,
      gtin: normalized.gtin,
      ncm: normalized.ncm,
      seo_keywords: normalized.seo_keywords,
      ad_titles: normalized.ad_titles,
      product_images: normalizeProductImagesForDb(normalized.product_images),
      stock_quantity: normalized.stock_quantity,
      width: normalized.width,
      height: normalized.height,
      length: normalized.length,
      weight: normalized.weight,
      assembled_width: normalized.assembled_width,
      assembled_height: normalized.assembled_height,
      assembled_length: normalized.assembled_length,
      assembled_weight: normalized.assembled_weight,
    });

    const result = await applyMarketplaceProductEnrichmentUpdate(supabase, userId, productId, {
      ...draft,
      picture_urls: normalized.picture_urls,
      category_ml_id: normalized.category_ml_id,
      stock_source: normalized.stock_source,
      source_external_listing_id: normalized.source_external_listing_id,
    });

    if (result.ok) stats.enriched += 1;
    else stats.errors.push({ stage: "persist", norm, productId, reason: result.reason });
  }

  return stats;
}
