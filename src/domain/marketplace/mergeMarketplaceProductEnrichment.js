// ======================================================================
// Política de merge — resync marketplace vs dados manuais (S1).
// ======================================================================

/** @param {unknown} v */
function isEmptyField(v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Monta patch de UPDATE permitido para produto existente.
 * @param {Record<string, unknown>} existing — linha products
 * @param {Record<string, unknown>} normalized — saída do adapter
 * @returns {Record<string, unknown>}
 */
export function buildMarketplaceProductEnrichmentPatch(existing, normalized) {
  const catalogSource = String(existing?.catalog_source || "").trim();
  const isMarketplaceImport = catalogSource === "marketplace_import";
  const stockSource = String(existing?.stock_source || "").trim();

  /** @type {Record<string, unknown>} */
  const patch = {
    marketplace_last_synced_at: new Date().toISOString(),
  };

  if (isEmptyField(existing?.marketplace_imported_at)) {
    patch.marketplace_imported_at = new Date().toISOString();
  }

  const fillOrRefresh = (col, value) => {
    if (value == null || (typeof value === "string" && value.trim() === "")) return;
    if (isEmptyField(existing?.[col])) {
      patch[col] = value;
      return;
    }
    if (isMarketplaceImport) {
      patch[col] = value;
    }
  };

  fillOrRefresh("product_name", normalized.product_name);
  fillOrRefresh("description", normalized.description);
  fillOrRefresh("brand", normalized.brand);
  fillOrRefresh("model", normalized.model);
  fillOrRefresh("gtin", normalized.gtin);
  fillOrRefresh("ncm", normalized.ncm);

  if (isMarketplaceImport) {
    patch.seo_keywords = normalized.seo_keywords ?? null;
  } else {
    fillOrRefresh("seo_keywords", normalized.seo_keywords);
  }

  fillOrRefresh("width", normalized.width);
  fillOrRefresh("height", normalized.height);
  fillOrRefresh("length", normalized.length);
  fillOrRefresh("weight", normalized.weight);
  fillOrRefresh("assembled_width", normalized.assembled_width);
  fillOrRefresh("assembled_height", normalized.assembled_height);
  fillOrRefresh("assembled_length", normalized.assembled_length);
  fillOrRefresh("assembled_weight", normalized.assembled_weight);

  if (normalized.ad_titles != null) {
    if (isEmptyField(existing?.ad_titles) || isMarketplaceImport) {
      patch.ad_titles = normalized.ad_titles;
    }
  }

  if (normalized.product_images != null) {
    if (isEmptyField(existing?.product_images) || isMarketplaceImport) {
      patch.product_images = normalized.product_images;
    }
  }

  if (normalized.category_ml_id != null) {
    fillOrRefresh("category_ml_id", normalized.category_ml_id);
  }

  if (normalized.source_external_listing_id != null && isMarketplaceImport) {
    patch.source_external_listing_id = normalized.source_external_listing_id;
  }

  if (normalized.stock_quantity != null) {
    const manualComValor =
      stockSource === "manual" && !isEmptyField(existing?.stock_quantity);
    if (!manualComValor) {
      patch.stock_quantity = normalized.stock_quantity;
      patch.stock_source = "marketplace";
    }
  }

  return patch;
}

/**
 * Links ML-importados são substituíveis quando ainda não há upload manual no bucket.
 * @param {Record<string, unknown>[]} links
 */
export function shouldReplaceMarketplaceImageLinks(links) {
  if (!Array.isArray(links) || links.length === 0) return true;
  return links.every((l) => {
    const fn = l?.file_name != null ? String(l.file_name) : "";
    const sp = l?.storage_path != null ? String(l.storage_path) : "";
    if (fn.startsWith("ml-import:")) return true;
    if (/mlstatic\.com/i.test(sp)) return true;
    if (sp.startsWith("http")) return true;
    return false;
  });
}
