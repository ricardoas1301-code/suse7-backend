// Unit smoke — S1 marketplace product normalization (sem rede)
import assert from "node:assert/strict";
import { pickPrimaryListingForSkuGroup } from "../src/domain/marketplace/pickPrimaryListingForSkuGroup.js";
import { normalizeMercadoLivreProductData } from "../src/domain/marketplace/adapters/mercadoLivreProductDataAdapter.js";
import { buildMarketplaceProductEnrichmentPatch } from "../src/domain/marketplace/mergeMarketplaceProductEnrichment.js";

const itemActive = {
  id: "MLB1",
  title: "Produto A",
  status: "active",
  sold_quantity: 10,
  available_quantity: 5,
  last_updated: "2026-06-20T10:00:00.000Z",
  pictures: [{ secure_url: "https://http2.mlstatic.com/a.jpg" }],
  attributes: [
    { id: "BRAND", value_name: "MarcaX" },
    { id: "NCM", value_name: "94036000" },
    { id: "GTIN", value_name: "7891234567890" },
    { id: "SELLER_PACKAGE_WIDTH", value_name: "20" },
    { id: "SELLER_PACKAGE_HEIGHT", value_name: "30" },
    { id: "SELLER_PACKAGE_LENGTH", value_name: "40" },
    { id: "SELLER_PACKAGE_WEIGHT", value_name: "1.5" },
  ],
  tags: [
    "good_quality_thumbnail",
    "standard_price_by_quantity",
    "immediate_payment",
  ],
};

const itemTabua = {
  id: "MLB6086562408",
  title: "Tábua De Passar Roupa Grande Reforçada Com Armário Rf Móveis Florido Branco",
  status: "active",
  sold_quantity: 159,
  available_quantity: 58,
  pictures: [{ secure_url: "https://http2.mlstatic.com/a.jpg" }],
  attributes: [
    { id: "BRAND", value_name: "RF Móveis" },
    { id: "SELLER_PACKAGE_WEIGHT", value_name: "8240 g" },
  ],
  tags: [
    "good_quality_thumbnail",
    "standard_price_by_quantity",
    "user_product_listing",
    "immediate_payment",
    "cart_eligible",
  ],
};

const itemPausedMoreSales = {
  id: "MLB2",
  title: "Produto B",
  status: "paused",
  sold_quantity: 99,
  available_quantity: 1,
  last_updated: "2026-06-25T10:00:00.000Z",
  pictures: [],
  attributes: [],
};

const primary = pickPrimaryListingForSkuGroup([
  { listingId: "1", item: itemPausedMoreSales, description: null, extId: "MLB2", resolvedSku: "SKU-1" },
  { listingId: "2", item: itemActive, description: null, extId: "MLB1", resolvedSku: "SKU-1", importOrder: 1 },
]);

assert.equal(primary?.extId, "MLB1", "anúncio ativo vence mesmo com menos vendas");

const normalized = normalizeMercadoLivreProductData(
  itemActive,
  { plain_text: "Descrição oficial ML" },
  "SKU-1",
  "MLB1"
);

assert.equal(normalized.brand, "MarcaX");
assert.equal(normalized.ncm, "94036000");
assert.equal(normalized.stock_quantity, 5);
assert.equal(normalized.picture_urls.length, 1);
assert.equal(normalized.weight, 1.5);

const normalizedTabua = normalizeMercadoLivreProductData(
  itemTabua,
  { plain_text: "Descrição" },
  "11011",
  "MLB6086562408"
);
assert.equal(normalizedTabua.weight, 8.24);
assert.ok(normalizedTabua.seo_keywords);
assert.ok(!normalizedTabua.seo_keywords.includes("good_quality_thumbnail"));
assert.ok(normalizedTabua.seo_keywords.includes("tabua de passar"));

const patchManualStock = buildMarketplaceProductEnrichmentPatch(
  { catalog_source: "marketplace_import", stock_source: "manual", stock_quantity: 10, description: "x" },
  { stock_quantity: 99, description: "nova", source_external_listing_id: "MLB1" }
);
assert.equal(patchManualStock.stock_quantity, undefined, "não sobrescreve estoque manual com valor");

const patchManualEmpty = buildMarketplaceProductEnrichmentPatch(
  { catalog_source: "marketplace_import", stock_source: "manual", stock_quantity: null, description: "x" },
  { stock_quantity: 58, source_external_listing_id: "MLB6086562408" }
);
assert.equal(patchManualEmpty.stock_quantity, 58, "importa estoque ML quando manual está vazio");
assert.equal(patchManualEmpty.stock_source, "marketplace");
assert.equal(patchManualEmpty.source_external_listing_id, "MLB6086562408");

const patchEmpty = buildMarketplaceProductEnrichmentPatch(
  { catalog_source: "manual", stock_quantity: null, description: null },
  { stock_quantity: 7, description: "desc" }
);
assert.equal(patchEmpty.stock_quantity, 7);
assert.equal(patchEmpty.description, "desc");

console.log("OK — test_marketplace_product_enrichment_s1_unit.mjs");
