/**
 * Contexto SSOT de produto/custos/estoque para o Raio-X do Anúncio (detail only).
 */

import { normalizeListingVirtualStockSummary } from "../../../../domain/listings/stock/normalizeListingVirtualStockSummary.js";

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text !== "" ? text : null;
}

/**
 * @param {unknown} value
 */
function numeroOuNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} money
 * @returns {string | null}
 */
function formatarMoedaBrlApi(money) {
  const n = numeroOuNull(money);
  if (n == null) return null;
  return n.toFixed(2);
}

/**
 * @param {unknown} attrsRaw
 * @param {string[]} attributeIds
 */
function pickAttributeValue(attrsRaw, attributeIds) {
  const attrs = Array.isArray(attrsRaw) ? attrsRaw : [];
  for (const raw of attrs) {
    if (!raw || typeof raw !== "object") continue;
    const attr = /** @type {Record<string, unknown>} */ (raw);
    const id = textoOuNull(attr.id)?.toUpperCase();
    if (!id || !attributeIds.includes(id)) continue;
    return textoOuNull(attr.value_name) ?? textoOuNull(attr.value_id) ?? null;
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} product
 * @param {Record<string, unknown> | null | undefined} variant
 * @param {Record<string, unknown>} rawItem
 */
function resolverCamposProdutoResumo(product, variant, rawItem) {
  const brand =
    textoOuNull(product?.brand) ??
    textoOuNull(variant?.brand) ??
    pickAttributeValue(rawItem.attributes, ["BRAND"]) ??
    pickAttributeValue(rawItem.attributes, ["MANUFACTURER"]) ??
    null;

  const model =
    textoOuNull(product?.model) ??
    textoOuNull(variant?.model) ??
    pickAttributeValue(rawItem.attributes, ["MODEL"]) ??
    null;

  const eanGtin =
    textoOuNull(product?.gtin) ??
    textoOuNull(variant?.gtin) ??
    pickAttributeValue(rawItem.attributes, ["GTIN", "EAN", "UPC", "ISBN"]) ??
    null;

  const ncm = textoOuNull(product?.ncm) ?? textoOuNull(variant?.ncm) ?? null;

  return { brand, model, ean_gtin: eanGtin, ncm };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} listingRow
 * @param {Record<string, unknown>} rawItem
 * @param {{ listingVirtualStockSettings?: Record<string, unknown> | null }} [options]
 */
export async function carregarContextoProdutoListingEditor(supabase, userId, listingRow, rawItem, options = {}) {
  const productId = textoOuNull(listingRow.product_id);
  const listingSku =
    pickAttributeValue(rawItem.attributes, ["SELLER_SKU", "SKU"]) ??
    textoOuNull(rawItem.seller_custom_field) ??
    textoOuNull(rawItem.seller_sku) ??
    textoOuNull(listingRow.seller_sku);

  /** @type {Record<string, unknown> | null} */
  let product = null;
  /** @type {Record<string, unknown> | null} */
  let variant = null;

  if (productId) {
    const { data: productRow } = await supabase
      .from("products")
      .select(
        "id, brand, model, gtin, ncm, cost_price, packaging_cost, operational_cost, stock_quantity, stock_minimum, use_virtual_stock, virtual_stock_quantity, width, height, length, weight, assembled_width, assembled_height, assembled_length, assembled_weight",
      )
      .eq("id", productId)
      .eq("user_id", userId)
      .maybeSingle();
    if (productRow && typeof productRow === "object") {
      product = /** @type {Record<string, unknown>} */ (productRow);
    }

    if (listingSku) {
      const { data: variantRow } = await supabase
        .from("product_variants")
        .select(
          "id, brand, model, gtin, ncm, cost_price, stock_quantity, use_virtual_stock, virtual_stock_quantity",
        )
        .eq("product_id", productId)
        .eq("user_id", userId)
        .or(`sku.eq.${listingSku},normalized_sku.eq.${listingSku}`)
        .maybeSingle();
      if (variantRow && typeof variantRow === "object") {
        variant = /** @type {Record<string, unknown>} */ (variantRow);
      }
    }
  }

  const campos = resolverCamposProdutoResumo(product, variant, rawItem);

  const productCost = formatarMoedaBrlApi(variant?.cost_price ?? product?.cost_price);
  const packagingCost = formatarMoedaBrlApi(product?.packaging_cost);
  const operationalCost = formatarMoedaBrlApi(product?.operational_cost);

  const listingStock =
    numeroOuNull(rawItem.available_quantity) ?? numeroOuNull(listingRow.available_quantity);

  const productVirtualEnabled = product?.use_virtual_stock === true || variant?.use_virtual_stock === true;
  const productVirtualQty = numeroOuNull(variant?.virtual_stock_quantity ?? product?.virtual_stock_quantity);
  const listingSettings =
    options.listingVirtualStockSettings && typeof options.listingVirtualStockSettings === "object"
      ? options.listingVirtualStockSettings
      : null;
  const stockSummary = normalizeListingVirtualStockSummary({
    product_stock: numeroOuNull(variant?.stock_quantity ?? product?.stock_quantity),
    product_min_stock: numeroOuNull(product?.stock_minimum),
    marketplace_listing_stock: listingStock,
    product_virtual_stock_enabled: productVirtualEnabled,
    product_virtual_stock_value: productVirtualQty,
    listing_virtual_stock_override_enabled: listingSettings?.override_enabled === true,
    listing_virtual_stock_value: listingSettings?.virtual_stock_value,
    listing_sync_status: null,
  });

  const productMeasurements = {
    shipping: {
      width_cm: numeroOuNull(product?.width),
      height_cm: numeroOuNull(product?.height),
      length_cm: numeroOuNull(product?.length),
      weight_kg: numeroOuNull(product?.weight),
    },
    product_mounted: {
      width_cm: numeroOuNull(product?.assembled_width),
      height_cm: numeroOuNull(product?.assembled_height),
      length_cm: numeroOuNull(product?.assembled_length),
      weight_kg: numeroOuNull(product?.assembled_weight),
    },
  };

  return {
    product_summary: {
      product_id: productId,
      variant_id: variant?.id != null ? String(variant.id) : null,
      brand: campos.brand,
      model: campos.model,
      ean_gtin: campos.ean_gtin,
      ncm: campos.ncm,
    },
    costs_summary: {
      product_cost_brl: productCost,
      packaging_cost_brl: packagingCost,
      operational_cost_brl: operationalCost,
    },
    stock_summary: stockSummary,
    product_measurements: productMeasurements,
    summary_fields: campos,
  };
}
