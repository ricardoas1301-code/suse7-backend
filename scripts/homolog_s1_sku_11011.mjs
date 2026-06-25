#!/usr/bin/env node
/**
 * Homologação S1 — SKU 11011 (DEV)
 * Uso: node scripts/homolog_s1_sku_11011.mjs [--apply-enrichment]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(backendRoot, "..");

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
  ...parseDotEnv(path.join(backendRoot, ".env.local")),
};
process.env.SUPABASE_URL = env.SUPABASE_URL || process.env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const TARGET_SKU = "11011";
const TARGET_USER = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const APPLY = process.argv.includes("--apply-enrichment");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** @param {unknown} v */
function pick(v) {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  return v;
}

/** @param {Record<string, unknown> | null | undefined} row */
function productSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku,
    normalized_sku: row.normalized_sku,
    product_name: row.product_name,
    gtin: row.gtin,
    brand: row.brand,
    model: row.model,
    ncm: row.ncm,
    seo_keywords: row.seo_keywords,
    description_len: row.description ? String(row.description).length : 0,
    description_preview: row.description ? String(row.description).slice(0, 120) : null,
    stock_quantity: row.stock_quantity,
    stock_source: row.stock_source,
    width: row.width,
    height: row.height,
    length: row.length,
    weight: row.weight,
    assembled_width: row.assembled_width,
    assembled_height: row.assembled_height,
    assembled_length: row.assembled_length,
    assembled_weight: row.assembled_weight,
    ad_titles: row.ad_titles,
    product_images_count: Array.isArray(row.product_images) ? row.product_images.length : 0,
    catalog_source: row.catalog_source,
    marketplace_imported_at: row.marketplace_imported_at,
    marketplace_last_synced_at: row.marketplace_last_synced_at,
    source_external_listing_id: row.source_external_listing_id,
  };
}

async function checkMigrationS1() {
  const cols = ["marketplace_imported_at", "marketplace_last_synced_at", "stock_source"];
  const { data, error } = await sb.from("products").select(cols.join(",")).limit(1);
  if (error) {
    return { applied: false, error: String(error.message || error) };
  }
  return { applied: true, sample: data?.[0] ?? null };
}

async function loadProductFull(userId, sku) {
  const { data, error } = await sb
    .from("products")
    .select(
      "id,user_id,sku,normalized_sku,product_name,gtin,brand,model,ncm,seo_keywords,description,stock_quantity,stock_minimum,stock_source,use_virtual_stock,virtual_stock_quantity,width,height,length,weight,assembled_width,assembled_height,assembled_length,assembled_weight,ad_titles,product_images,catalog_source,marketplace_imported_at,marketplace_last_synced_at,source_external_listing_id,imported_from_channel,is_imported_from_marketplace"
    )
    .eq("user_id", userId)
    .or(`sku.eq.${sku},normalized_sku.eq.${sku}`);

  if (error) throw error;
  return data || [];
}

async function loadListingsForProduct(productId, userId) {
  const { data, error } = await sb
    .from("marketplace_listings")
    .select(
      "id,external_listing_id,product_id,status,title,available_quantity,raw_json,marketplace,updated_at"
    )
    .eq("user_id", userId)
    .eq("product_id", productId)
    .order("external_listing_id");

  if (error) throw error;
  return data || [];
}

async function loadImageLinks(productId, userId) {
  const { data, error } = await sb
    .from("product_image_links")
    .select("id,sort_order,is_primary,storage_path,file_name,mime_type")
    .eq("product_id", productId)
    .eq("user_id", userId)
    .is("variant_key", null)
    .order("sort_order");

  if (error) throw error;
  return data || [];
}

async function loadDescriptions(listingIds) {
  if (!listingIds.length) return [];
  const { data, error } = await sb
    .from("marketplace_listing_descriptions")
    .select("listing_id,plain_text")
    .in("listing_id", listingIds);
  if (error) throw error;
  return data || [];
}

/** @param {Record<string, unknown>} raw */
function listingMetricsFromRaw(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  return {
    status: pick(item.status),
    sold_quantity: item.sold_quantity ?? null,
    last_updated: item.last_updated ?? null,
    date_created: item.date_created ?? null,
    available_quantity: item.available_quantity ?? null,
    pictures_count: Array.isArray(item.pictures) ? item.pictures.length : 0,
  };
}

async function applyEnrichment(userId, listings, descriptionsByListing) {
  const { pickPrimaryListingForSkuGroup } = await import(
    "../src/domain/marketplace/pickPrimaryListingForSkuGroup.js"
  );
  const { enrichProductsFromPreparedListingBatch } = await import(
    "../src/handlers/ml/_helpers/marketplaceProductEnrichmentPersist.js"
  );
  const { extractSellerSku } = await import("../src/handlers/ml/_helpers/mlItemSkuExtract.js");
  const { normalizeSkuForDbLookup } = await import("../src/domain/productCatalogCompleteness.js");

  /** @type {Map<string, string>} */
  const productIdByNorm = new Map();
  const norm = normalizeSkuForDbLookup(TARGET_SKU);
  const productId = listings[0]?.product_id;
  if (productId && norm) productIdByNorm.set(norm, String(productId));

  const prepared = listings
    .map((l) => {
      const raw = l.raw_json && typeof l.raw_json === "object" ? l.raw_json : null;
      if (!raw) return null;
      const resolvedSku = extractSellerSku(raw);
      if (!resolvedSku) return null;
      const descRow = descriptionsByListing.get(l.id);
      const description = descRow?.plain_text != null ? { plain_text: descRow.plain_text } : null;
      return {
        listingId: l.id,
        norm: normalizeSkuForDbLookup(resolvedSku),
        resolvedSku,
        item: raw,
        description,
        extId: l.external_listing_id,
      };
    })
    .filter(Boolean);

  const primary = pickPrimaryListingForSkuGroup(prepared);
  const stats = await enrichProductsFromPreparedListingBatch(sb, userId, productIdByNorm, prepared);
  return { primary_ext_id: primary?.extId ?? null, stats, prepared_count: prepared.length };
}

async function main() {
  const started = new Date().toISOString();
  const migration = await checkMigrationS1();

  const productsBefore = await loadProductFull(TARGET_USER, TARGET_SKU);
  if (productsBefore.length === 0) {
    console.error("Produto SKU", TARGET_SKU, "não encontrado para user", TARGET_USER);
    process.exit(1);
  }
  if (productsBefore.length > 1) {
    console.warn("AVISO: mais de um produto com SKU", TARGET_SKU, productsBefore.map((p) => p.id));
  }

  const product = productsBefore[0];
  const listings = await loadListingsForProduct(product.id, TARGET_USER);
  const imageLinksBefore = await loadImageLinks(product.id, TARGET_USER);
  const descRows = await loadDescriptions(listings.map((l) => l.id));
  const descMap = new Map(descRows.map((d) => [d.listing_id, d]));

  const listingsDetail = listings.map((l) => ({
    id: l.id,
    external_listing_id: l.external_listing_id,
    status: l.status,
    title: l.title,
    available_quantity: l.available_quantity,
    description_len: descMap.get(l.id)?.plain_text?.length ?? 0,
    ...listingMetricsFromRaw(l.raw_json),
  }));

  const { pickPrimaryListingForSkuGroup } = await import(
    "../src/domain/marketplace/pickPrimaryListingForSkuGroup.js"
  );
  const { extractSellerSku } = await import("../src/handlers/ml/_helpers/mlItemSkuExtract.js");

  const preparedForPick = listings
    .map((l, i) => {
      const raw = l.raw_json && typeof l.raw_json === "object" ? l.raw_json : null;
      if (!raw) return null;
      const resolvedSku = extractSellerSku(raw);
      if (!resolvedSku) return null;
      return {
        listingId: l.id,
        item: raw,
        description: null,
        extId: l.external_listing_id,
        resolvedSku,
        importOrder: i,
      };
    })
    .filter(Boolean);

  const expectedPrimary = pickPrimaryListingForSkuGroup(preparedForPick);

  let enrichmentResult = null;
  if (APPLY) {
    enrichmentResult = await applyEnrichment(TARGET_USER, listings, descMap);
  }

  const productsAfter = await loadProductFull(TARGET_USER, TARGET_SKU);
  const productAfter = productsAfter[0];
  const imageLinksAfter = await loadImageLinks(product.id, TARGET_USER);

  const report = {
    meta: {
      started,
      sku: TARGET_SKU,
      user_id: TARGET_USER,
      apply_enrichment: APPLY,
      migration_s1: migration,
    },
    grouping: {
      products_with_sku: productsBefore.length,
      product_id: product.id,
      listings_linked: listings.length,
      listing_external_ids: listings.map((l) => l.external_listing_id),
    },
    primary_listing_rule: {
      chosen_external_id: expectedPrimary?.extId ?? null,
      chosen_status: expectedPrimary?.item?.status ?? null,
      chosen_sold_quantity: expectedPrimary?.item?.sold_quantity ?? null,
      chosen_title: expectedPrimary?.item?.title ?? null,
      all_listings_rank_input: listingsDetail,
    },
    before: {
      product: productSnapshot(product),
      image_links: imageLinksBefore,
    },
    after: {
      product: productSnapshot(productAfter),
      image_links: imageLinksAfter,
    },
    enrichment_run: enrichmentResult,
    validation: {
      single_product: productsBefore.length === 1,
      migration_applied: migration.applied,
      has_stock: productAfter?.stock_quantity != null,
      stock_source_marketplace: productAfter?.stock_source === "marketplace",
      has_images_json: (productAfter?.product_images?.length ?? 0) > 0,
      has_image_links: imageLinksAfter.length > 0,
      has_description: (productAfter?.description?.length ?? 0) > 0,
      has_ad_titles: Array.isArray(productAfter?.ad_titles) && productAfter.ad_titles.length > 0,
      primary_matches_source:
        !productAfter?.source_external_listing_id ||
        productAfter.source_external_listing_id === expectedPrimary?.extId,
    },
  };

  const outPath = path.join(repoRoot, "scripts", "output", `HOMOLOG_S1_SKU_11011_${started.slice(0, 10)}.json`);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

  const mdPath = path.join(repoRoot, "scripts", "output", `HOMOLOG_S1_SKU_11011_${started.slice(0, 10)}.md`);

  const b = report.before.product;
  const a = report.after.product;
  const md = `# Homologação S1 — SKU ${TARGET_SKU}

**Data:** ${started}  
**Ambiente:** DEV Supabase  
**Enrichment aplicado nesta execução:** ${APPLY ? "sim" : "não (somente leitura)"}

## 1. Migration S1

| Check | Resultado |
|-------|-----------|
| Colunas marketplace S1 | ${migration.applied ? "✅ aplicada" : "❌ NÃO detectada"} |

## 2. Agrupamento

- Produtos SKU ${TARGET_SKU}: **${report.grouping.products_with_sku}**
- product_id: \`${report.grouping.product_id}\`
- Anúncios: **${report.grouping.listings_linked}** — ${report.grouping.listing_external_ids.join(", ")}

## 3. Anúncio principal

- Escolhido: \`${report.primary_listing_rule.chosen_external_id ?? "—"}\`
- status: ${report.primary_listing_rule.chosen_status}
- sold: ${report.primary_listing_rule.chosen_sold_quantity}

## 4. Antes → Depois

| Campo | Antes | Depois |
|-------|-------|--------|
| gtin | ${b?.gtin ?? "—"} | ${a?.gtin ?? "—"} |
| brand | ${b?.brand ?? "—"} | ${a?.brand ?? "—"} |
| ncm | ${b?.ncm ?? "—"} | ${a?.ncm ?? "—"} |
| stock | ${b?.stock_quantity ?? "—"} (${b?.stock_source ?? "—"}) | ${a?.stock_quantity ?? "—"} (${a?.stock_source ?? "—"}) |
| description chars | ${b?.description_len ?? 0} | ${a?.description_len ?? 0} |
| images jsonb / links | ${b?.product_images_count ?? 0} / ${imageLinksBefore.length} | ${a?.product_images_count ?? 0} / ${imageLinksAfter.length} |
| dims W×H×L×Wt | ${[b?.width, b?.height, b?.length, b?.weight].join("×")} | ${[a?.width, a?.height, a?.length, a?.weight].join("×")} |
| synced_at | ${b?.marketplace_last_synced_at ?? "—"} | ${a?.marketplace_last_synced_at ?? "—"} |

## 5. Validação

${Object.entries(report.validation)
  .map(([k, v]) => `- ${k}: ${v ? "✅" : "❌"}`)
  .join("\n")}
`;

  await fs.writeFile(mdPath, md, "utf8");
  console.log("Report:", mdPath);
  console.log(JSON.stringify(report.validation, null, 2));
  if (!migration.applied) {
    console.error("\nBLOCKER: migration S1 não aplicada.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
