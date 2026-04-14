// ======================================================================
// Vínculo automático listing → produto por SKU (multi-marketplace-ready).
// - Busca por normalized_sku (case-insensitive no DB).
// - Batch insert de produtos após import em lote.
// ======================================================================

import { ML_MARKETPLACE_SLUG, ML_MARKETPLACE_LISTING_ALIASES } from "./mlMarketplace.js";
import { extractSellerSku, ATTENTION_REASON_SKU_PENDING_ML } from "./mlItemSkuExtract.js";
import { normalizeAdTitles } from "../../../utils/normalizeAdTitles.js";
import { normalizeProductPayload } from "../../../domain/ProductDomainService.js";
import { normalizeSkuForDbLookup, resolveCatalogCompleteness } from "../../../domain/productCatalogCompleteness.js";
import { buildProductInsertPayload } from "../../products/create.js";
import { syncListingHealthProductSnapshot } from "./syncListingHealthProductSnapshot.js";

const PRODUCT_INSERT_CHUNK = Math.min(
  100,
  Math.max(10, parseInt(process.env.ML_IMPORT_PRODUCT_BATCH_SIZE || "50", 10) || 50)
);

const BACKFILL_LISTINGS_PAGE = Math.min(
  200,
  Math.max(20, parseInt(process.env.ML_BACKFILL_LISTINGS_PAGE_SIZE || "100", 10) || 100)
);
const BACKFILL_MAX_LOOPS = Math.min(
  200,
  Math.max(1, parseInt(process.env.ML_BACKFILL_MAX_LOOPS || "50", 10) || 50)
);

/** @param {unknown} err */
export function tracePgErr(err) {
  if (err == null) return null;
  if (typeof err !== "object") return { message: String(err) };
  const o = /** @type {Record<string, unknown>} */ (err);
  const x = {
    message: o.message != null ? String(o.message) : undefined,
    code: o.code != null ? String(o.code) : undefined,
    details: o.details,
    hint: o.hint != null ? String(o.hint) : undefined,
  };
  return /** @type {Record<string, unknown>} */ (
    Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== null && v !== ""))
  );
}

/**
 * @param {{ trace?: object[] }} opts
 * @param {string} event
 * @param {Record<string, unknown>} [data]
 */
function tracePush(opts, event, data = {}) {
  const arr = opts.trace;
  if (!Array.isArray(arr)) return;
  arr.push({ at: new Date().toISOString(), event, ...data });
}

/**
 * Linha salva em `products` para import do marketplace (uma fonte de verdade).
 * @param {string} userId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} description
 * @param {string} resolvedSku
 * @param {string} extId external_listing_id (MLB…)
 */
export function buildMarketplaceImportProductRow(userId, item, description, resolvedSku, extId) {
  const draft = buildMarketplaceDraftProductPayload(userId, item, description, resolvedSku, extId);
  const completeness = resolveCatalogCompleteness(
    {
      cost_price: draft.cost_price,
      packaging_cost: draft.packaging_cost,
      operational_cost: draft.operational_cost,
    },
    { catalog_source: "marketplace_import" }
  );

  const skuNorm = normalizeSkuForDbLookup(resolvedSku);
  /** @type {any} */
  const g = buildMarketplaceImportProductRow;
  g._logCount = (g._logCount ?? 0) + 1;
  const n = g._logCount;
  if (n <= 40 || n % 80 === 0 || process.env.ML_LOG_EVERY_PRODUCT_ROW === "1") {
    console.log("[ml/listing-product-link] buildMarketplaceImportProductRow", {
      rowSeq: n,
      user_id_prefix: String(userId).slice(0, 8),
      ext_id: String(extId).trim(),
      resolved_sku: resolvedSku,
      normalized_sku: skuNorm,
      catalog_source: "marketplace_import",
      completeness,
      title_preview:
        draft?.product_name != null
          ? String(draft.product_name).slice(0, 60)
          : item?.title != null
            ? String(item.title).slice(0, 60)
            : null,
    });
  }

  return {
    ...buildProductInsertPayload(draft, userId),
    category_ml_id: draft.category_ml_id != null ? String(draft.category_ml_id) : null,
    imported_from_channel: ML_MARKETPLACE_SLUG,
    catalog_source: "marketplace_import",
    catalog_completeness: completeness,
    is_imported_from_marketplace: true,
    completion_status: "incomplete",
    missing_required_costs: true,
    source_marketplace: ML_MARKETPLACE_SLUG,
    source_external_listing_id: String(extId).trim(),
    cost_price: null,
    packaging_cost: null,
    operational_cost: null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} normalizedSku UPPER + trim + single spaces (igual ao DB)
 */
export async function findProductIdByNormalizedSku(supabase, userId, normalizedSku) {
  if (!normalizedSku) return null;
  const norm = normalizeSkuForDbLookup(String(normalizedSku));
  if (!norm) return null;
  const { productIdByNorm } = await hydrateProductIdByNormForSkus(
    supabase,
    userId,
    [norm],
    new Map([[norm, String(normalizedSku).trim() || norm]]),
    () => {},
    { skipLookupLog: true },
  );
  return productIdByNorm.get(norm) ?? null;
}

/**
 * Lookup completo antes de INSERT: products.normalized_sku, products.sku e product_variants.sku
 * (sempre comparando SKU normalizado: trim + espaços + UPPER).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} uniqueNorms — chaves já normalizadas
 * @param {Map<string, string>} normToInputSku — norm → SKU “cru” do anúncio/body (log)
 * @param {(m: string, x?: object) => void} log
 * @param {{ skipLookupLog?: boolean }} [options]
 * @returns {Promise<{ productIdByNorm: Map<string, string>; foundInByNorm: Map<string, 'products' | 'variants'>; error: object | null }>}
 */
async function hydrateProductIdByNormForSkus(supabase, userId, uniqueNorms, normToInputSku, log, options = {}) {
  void log;
  const { skipLookupLog = false } = options || {};
  /** @type {Map<string, string>} */
  const productIdByNorm = new Map();
  /** @type {Map<string, 'products' | 'variants'>} */
  const foundInByNorm = new Map();

  const norms = [...new Set((uniqueNorms || []).map((n) => normalizeSkuForDbLookup(String(n || ""))).filter(Boolean))];
  const normSet = new Set(norms);
  const logLookup = () => {
    if (skipLookupLog) return;
    for (const n of norms) {
      console.log(
        "[PRODUCT_LOOKUP_RESULT]",
        JSON.stringify({
          input_sku: normToInputSku.has(n) ? normToInputSku.get(n) : null,
          normalized_sku: n,
          found_in: foundInByNorm.get(n) ?? null,
          product_id: productIdByNorm.get(n) ?? null,
        }),
      );
    }
  };

  if (norms.length === 0) {
    return { productIdByNorm, foundInByNorm, error: null };
  }

  const { data: rowEq, error: err1 } = await supabase
    .from("products")
    .select("id, normalized_sku")
    .eq("user_id", userId)
    .in("normalized_sku", norms);

  if (err1) {
    console.error("[ml/listing-product-link] hydrate normalized_sku query", err1);
    return { productIdByNorm, foundInByNorm, error: err1 };
  }

  for (const r of rowEq || []) {
    const nk = normalizeSkuForDbLookup(String(r.normalized_sku ?? ""));
    if (nk && normSet.has(nk) && r.id && !productIdByNorm.has(nk)) {
      productIdByNorm.set(nk, r.id);
      foundInByNorm.set(nk, "products");
    }
  }

  let missing = norms.filter((n) => !productIdByNorm.has(n));
  if (missing.length === 0) {
    logLookup();
    return { productIdByNorm, foundInByNorm, error: null };
  }

  const { data: allProducts, error: err2 } = await supabase
    .from("products")
    .select("id, sku, normalized_sku")
    .eq("user_id", userId);

  if (err2) {
    console.error("[ml/listing-product-link] hydrate products scan", err2);
    return { productIdByNorm, foundInByNorm, error: err2 };
  }

  const miss = new Set(missing);
  for (const r of allProducts || []) {
    if (!r?.id) continue;
    const normCol =
      r.normalized_sku != null && String(r.normalized_sku).trim() !== ""
        ? normalizeSkuForDbLookup(String(r.normalized_sku))
        : "";
    const skuEff = normalizeSkuForDbLookup(String(r.sku ?? ""));
    /** @type {string[]} */
    const keys = [...new Set([normCol, skuEff].filter(Boolean))];
    for (const nk of keys) {
      if (miss.has(nk) && !productIdByNorm.has(nk)) {
        productIdByNorm.set(nk, r.id);
        foundInByNorm.set(nk, "products");
      }
    }
  }

  missing = norms.filter((n) => !productIdByNorm.has(n));
  if (missing.length === 0) {
    logLookup();
    return { productIdByNorm, foundInByNorm, error: null };
  }

  const missV = new Set(missing);
  const productIds = [...new Set((allProducts || []).map((p) => p.id).filter(Boolean))];
  if (productIds.length > 0) {
    const { data: vars, error: err3 } = await supabase.from("product_variants").select("product_id, sku").in("product_id", productIds);
    if (err3) {
      console.error("[ml/listing-product-link] hydrate variants scan", err3);
      return { productIdByNorm, foundInByNorm, error: err3 };
    }
    for (const v of vars || []) {
      const nv = normalizeSkuForDbLookup(String(v.sku ?? ""));
      if (nv && missV.has(nv) && v.product_id && !productIdByNorm.has(nv)) {
        productIdByNorm.set(nv, v.product_id);
        foundInByNorm.set(nv, "variants");
      }
    }
  }

  logLookup();
  return { productIdByNorm, foundInByNorm, error: null };
}

/**
 * @param {Record<string, unknown>} item
 */
function pickAttrValue(item, ids) {
  const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
  for (const id of ids) {
    const a = attrs.find((x) => x && typeof x === "object" && String(x.id) === id);
    const vn = a?.value_name;
    if (vn != null && String(vn).trim() !== "") return String(vn).trim();
  }
  return null;
}

function digitsOrNull(v) {
  if (v == null || v === "") return null;
  const d = String(v).replace(/\D/g, "");
  return d === "" ? null : d;
}

/**
 * Monta draft normalizado (sem colunas finais de import).
 * @param {string} externalListingId — MLB… para source_external_listing_id no raw
 */
export function buildMarketplaceDraftProductPayload(
  userId,
  item,
  description,
  resolvedSku,
  externalListingId
) {
  void userId;
  const title = item?.title != null ? String(item.title).trim() : "";
  const plainDesc =
    description && typeof description === "object" && description.plain_text != null
      ? String(description.plain_text).trim()
      : "";

  const pics = Array.isArray(item?.pictures) ? item.pictures : [];
  const product_images = pics.length
    ? pics
        .map((p) => {
          const u = p?.secure_url || p?.url;
          return u && String(u).startsWith("http") ? { url: String(u) } : null;
        })
        .filter(Boolean)
    : null;

  const brand = pickAttrValue(item, ["BRAND", "MANUFACTURER"]);
  const model = pickAttrValue(item, ["MODEL", "MODEL_NAME"]);
  const gtin =
    digitsOrNull(pickAttrValue(item, ["GTIN", "EAN", "BARCODE", "ISBN"])) ??
    digitsOrNull(item?.catalog_product_id);

  const weightNum = (() => {
    const w = pickAttrValue(item, ["WEIGHT", "PACKAGE_WEIGHT"]);
    if (!w) return null;
    const n = parseFloat(String(w).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  })();

  const height = pickAttrValue(item, ["HEIGHT", "SELLER_PACKAGE_HEIGHT"]);
  const width = pickAttrValue(item, ["WIDTH", "SELLER_PACKAGE_WIDTH"]);
  const length = pickAttrValue(item, ["LENGTH", "SELLER_PACKAGE_LENGTH"]);
  const toDim = (x) => {
    if (x == null) return null;
    const n = parseFloat(String(x).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  const ext = externalListingId != null ? String(externalListingId).trim() : "";

  const raw = {
    product_name: title || resolvedSku || "Produto importado",
    format: "simple",
    sku: resolvedSku,
    description: plainDesc || null,
    brand: brand || null,
    model: model || null,
    gtin: gtin || null,
    category_ml_id: item?.category_id != null ? String(item.category_id) : null,
    ad_titles: normalizeAdTitles([{ value: title || resolvedSku }]),
    product_images,
    weight: weightNum,
    height: toDim(height),
    width: toDim(width),
    length: toDim(length),
    imported_from_channel: ML_MARKETPLACE_SLUG,
    cost_price: null,
    packaging_cost: null,
    operational_cost: null,
    catalog_source: "marketplace_import",
    catalog_completeness: "draft_imported_from_marketplace",
    source_external_listing_id: ext || null,
  };

  return normalizeProductPayload(raw);
}

/**
 * @param {string | null | undefined} externalListingId
 */
/**
 * SKU usado para criar/vincular produto: apenas SKU informado pelo vendedor no ML.
 * Sem SKU no ML → null (anúncio importado com pendência; sem produto automático por id MLB).
 */
export function resolveSkuForListingLink(item, externalListingId) {
  void externalListingId;
  const fromItem = extractSellerSku(item);
  if (fromItem && String(fromItem).trim() !== "") return String(fromItem).trim();
  return null;
}

/** @param {Record<string, unknown> | null | undefined} p */
function isListingFinancialBlocked(p) {
  if (!p) return true;
  const catOk = (p.catalog_completeness || "") === "complete";
  const compOk = p.completion_status !== "incomplete";
  const costsOk = p.missing_required_costs !== true;
  return !(catOk && compOk && costsOk);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId uuid
 * @param {string | null} productId uuid
 * @returns {Promise<{ ok: boolean; reason?: string }>}
 */
export async function applyListingProductLinkAndFinancialFlag(supabase, userId, listingId, productId) {
  const { data: listingMeta } = await supabase
    .from("marketplace_listings")
    .select("external_listing_id, marketplace, attention_reason")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!productId) {
    const { error: clrErr } = await supabase
      .from("marketplace_listings")
      .update({
        product_id: null,
        financial_analysis_blocked: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listingId)
      .eq("user_id", userId);
    if (clrErr) {
      console.error("[ml/listing-product-link] listing_clear_product_failed", { listingId, clrErr });
    } else if (listingMeta?.external_listing_id) {
      void syncListingHealthProductSnapshot(
        supabase,
        userId,
        listingMeta.marketplace != null ? String(listingMeta.marketplace) : ML_MARKETPLACE_SLUG,
        listingMeta.external_listing_id,
        { product_id: null, attention_reason: listingMeta.attention_reason },
      );
    }
    return { ok: !clrErr, reason: clrErr ? "clear_failed" : "cleared" };
  }

  const { data: p, error } = await supabase
    .from("products")
    .select("catalog_completeness, completion_status, missing_required_costs")
    .eq("id", productId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[ml/listing-product-link] load_product_completeness", error);
    return { ok: false, reason: "load_product" };
  }

  const blocked = isListingFinancialBlocked(p);

  const { data: updRows, error: updErr } = await supabase
    .from("marketplace_listings")
    .update({
      product_id: productId,
      financial_analysis_blocked: blocked,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId)
    .eq("user_id", userId)
    .select("id, product_id");

  if (updErr) {
    console.error("[ml/listing-product-link] listing_product_id_update_failed", {
      listingId,
      productId,
      userId,
      updErr,
    });
    return { ok: false, reason: "update_error" };
  }
  if (!updRows?.length) {
    console.warn("[ml/listing-product-link] listing_product_id_update_zero_rows", {
      listingId,
      userId,
      productId,
      hint: "listing_id / user_id não bateram ou coluna product_id ausente no schema",
    });
    return { ok: false, reason: "zero_rows" };
  }
  console.log("[ml/listing-product-link] marketplace_listing_product_id SET", {
    listingId,
    productId,
    returned_rows: updRows?.length ?? 0,
    financial_blocked: blocked,
  });
  if (listingMeta?.external_listing_id) {
    void syncListingHealthProductSnapshot(
      supabase,
      userId,
      listingMeta.marketplace != null ? String(listingMeta.marketplace) : ML_MARKETPLACE_SLUG,
      listingMeta.external_listing_id,
      { product_id: productId, attention_reason: listingMeta.attention_reason },
    );
  }
  return { ok: true };
}

/**
 * Após import em lote: cria produtos faltantes (batch) e vincula listings.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ listingId: string; item: Record<string, unknown>; description: object | null }[]} entries
 * @param {{
 *   log?: (m: string, x?: object) => void;
 *   trace?: { at: string; event: string; [k: string]: unknown }[];
 * }} [opts]
 */
export async function batchEnsureProductsForListings(supabase, userId, entries, opts = {}) {
  /** reinicia amostragem de logs por batch */
  /** @type {any} */
  (buildMarketplaceImportProductRow)._logCount = 0;

  const log = opts.log || (() => {});
  const out = {
    products_created: 0,
    listings_linked_existing_product: 0,
    listings_linked_new_product: 0,
    listings_skipped_no_sku: 0,
    listings_update_applied: 0,
    listings_entries_invalid: 0,
    errors: /** @type {object[]} */ ([]),
  };

  if (!entries?.length) {
    tracePush(opts, "batch_skip_empty", { userId });
    console.log("[ml/listing-product-link] batchEnsureProductsForListings SKIP empty entries", { userId });
    log("batch_products_skip_empty_entries", { userId });
    return out;
  }

  tracePush(opts, "batch_start", {
    userId,
    entries_in: entries.length,
    listing_ids_head: entries.slice(0, 12).map((e) => e.listingId),
  });
  console.log("[ml/listing-product-link] batchEnsureProductsForListings START", {
    userId,
    entries_in: entries.length,
    listing_ids_head: entries.slice(0, 8).map((e) => e.listingId),
  });

  log("batch_products_start", {
    userId,
    entries_in: entries.length,
    listing_ids_sample: entries.slice(0, 5).map((e) => e.listingId),
    has_item: entries.filter((e) => e.item && typeof e.item === "object").length,
  });

  /** @type {{ listingId: string; norm: string; resolvedSku: string; item: Record<string, unknown>; description: object | null; extId: string }[]} */
  const prepared = [];

  for (const e of entries) {
    const item = e.item;
    const extId = item?.id != null ? String(item.id) : null;
    if (!e.listingId) {
      out.listings_entries_invalid += 1;
      continue;
    }
    if (!extId) {
      out.listings_entries_invalid += 1;
      log("batch_product_skip_item_no_id", { listingId: e.listingId });
      continue;
    }
    const resolvedSku = resolveSkuForListingLink(item, extId);
    if (!resolvedSku) {
      out.listings_skipped_no_sku += 1;
      log("batch_product_skip_no_sku", { listingId: e.listingId, external_listing_id: extId });
      continue;
    }
    const norm = normalizeSkuForDbLookup(resolvedSku);
    if (!norm) {
      out.listings_skipped_no_sku += 1;
      continue;
    }
    prepared.push({
      listingId: e.listingId,
      norm,
      resolvedSku,
      item,
      description: e.description ?? null,
      extId,
    });
  }

  if (prepared.length === 0) {
    tracePush(opts, "batch_no_prepared", {
      userId,
      entries_in: entries.length,
      skipped_no_sku: out.listings_skipped_no_sku,
      invalid: out.listings_entries_invalid,
    });
    console.warn("[ml/listing-product-link] batchEnsureProductsForListings NO prepared rows (sem SKU resolvido ou inválido)", {
      userId,
      entries_in: entries.length,
      skipped_no_sku: out.listings_skipped_no_sku,
      invalid: out.listings_entries_invalid,
    });
    log("batch_products_no_prepared_after_sku", {
      userId,
      entries_in: entries.length,
      skipped_no_sku: out.listings_skipped_no_sku,
      invalid: out.listings_entries_invalid,
    });
    return out;
  }

  const uniqueNorms = [...new Set(prepared.map((p) => p.norm))];

  tracePush(opts, "batch_prepared", {
    prepared_count: prepared.length,
    unique_normalized_skus: uniqueNorms.length,
    sku_norms_head: uniqueNorms.slice(0, 15),
  });

  log("batch_products_prepared", {
    userId,
    prepared_count: prepared.length,
    unique_normalized_skus: uniqueNorms.length,
    sku_norms_sample: uniqueNorms.slice(0, 20),
    resolved_skus_sample: prepared.slice(0, 10).map((p) => ({ norm: p.norm, sku: p.resolvedSku, ext: p.extId })),
  });

  /** @type {Map<string, string>} */
  const normToInputSku = new Map();
  for (const p of prepared) {
    if (!normToInputSku.has(p.norm)) normToInputSku.set(p.norm, p.resolvedSku);
  }

  const {
    productIdByNorm,
    error: hydErr,
  } = await hydrateProductIdByNormForSkus(supabase, userId, uniqueNorms, normToInputSku, log);

  if (hydErr) {
    tracePush(opts, "batch_select_existing_failed", { error: tracePgErr(hydErr) });
    console.error("[ml/listing-product-link] batch_product_hydrate_failed", hydErr);
    out.errors.push({ stage: "select_existing_products", error: hydErr });
    return out;
  }

  /** Normas que já tinham produto antes de qualquer INSERT (métricas de vínculo) */
  const normsExistingBeforeCreate = new Set(productIdByNorm.keys());

  /** norm → primeira entrada (define dados do insert) */
  /** @type {Map<string, (typeof prepared)[0]>} */
  const firstByNorm = new Map();
  for (const p of prepared) {
    if (!productIdByNorm.has(p.norm) && !firstByNorm.has(p.norm)) {
      firstByNorm.set(p.norm, p);
    }
  }

  const toInsert = [...firstByNorm.values()].map((p) =>
    buildMarketplaceImportProductRow(userId, p.item, p.description, p.resolvedSku, p.extId)
  );

  log("batch_products_existing_in_db", {
    userId,
    existing_products_matched: normsExistingBeforeCreate.size,
    distinct_new_norms_to_insert: firstByNorm.size,
    to_insert_rows: toInsert.length,
  });

  tracePush(opts, "batch_existing_and_inserts", {
    existing_products_matched: normsExistingBeforeCreate.size,
    to_insert_rows: toInsert.length,
  });

  for (let i = 0; i < toInsert.length; i += PRODUCT_INSERT_CHUNK) {
    const chunk = toInsert
      .slice(i, i + PRODUCT_INSERT_CHUNK)
      .filter((row) => {
        const n = normalizeSkuForDbLookup(String(row.sku || ""));
        return n && !productIdByNorm.has(n);
      });
    if (chunk.length === 0) continue;

    const { data: inserted, error: insErr } = await supabase
      .from("products")
      .insert(chunk)
      .select("id, normalized_sku");

    if (insErr) {
      tracePush(opts, "batch_insert_failed", {
        error: tracePgErr(insErr),
        chunk_size: chunk.length,
        chunk_offset: i,
        first_row_keys: chunk[0] ? Object.keys(chunk[0]).slice(0, 40) : [],
      });
      console.error("[ml/listing-product-link] batch_insert_failed", {
        message: insErr.message,
        code: insErr.code,
        details: insErr.details,
        hint: insErr.hint,
        chunk_size: chunk.length,
        first_chunk_keys: chunk[0] ? Object.keys(chunk[0]) : [],
      });
      out.errors.push({ stage: "batch_insert_products", error: insErr, chunkSize: chunk.length });
      /** Duplicidade / corrida: reidratar mapa sem novo INSERT */
      const chunkNorms = [
        ...new Set(chunk.map((row) => normalizeSkuForDbLookup(String(row.sku || ""))).filter(Boolean)),
      ];
      const recoverMap = new Map(normToInputSku);
      for (const row of chunk) {
        const n = normalizeSkuForDbLookup(String(row.sku || ""));
        if (n && !recoverMap.has(n)) recoverMap.set(n, String(row.sku ?? ""));
      }
      const {
        productIdByNorm: recovered,
        error: recErr,
      } = await hydrateProductIdByNormForSkus(supabase, userId, chunkNorms, recoverMap, log, { skipLookupLog: false });
      if (recErr) {
        out.errors.push({ stage: "batch_insert_recover_lookup", error: recErr });
      } else {
        for (const [nk, pid] of recovered) {
          if (nk && pid) productIdByNorm.set(nk, pid);
        }
      }
    } else {
      tracePush(opts, "batch_insert_ok", {
        inserted_count: (inserted || []).length,
        ids_head: (inserted || []).slice(0, 8).map((r) => ({ id: r.id, normalized_sku: r.normalized_sku })),
      });
      console.log("[ml/listing-product-link] products INSERT ok", {
        inserted_count: (inserted || []).length,
        ids_head: (inserted || []).slice(0, 5).map((r) => ({ id: r.id, normalized_sku: r.normalized_sku })),
      });
      for (const ins of inserted || []) {
        const nk = normalizeSkuForDbLookup(String(ins.normalized_sku ?? ""));
        if (nk && ins.id) {
          productIdByNorm.set(nk, ins.id);
        }
      }
      out.products_created += (inserted || []).length;
    }
  }

  log("batch_products_insert_phase_done", {
    userId,
    products_created_this_batch: out.products_created,
    norms_in_map: productIdByNorm.size,
    prepared_listings: prepared.length,
  });

  let linkTraceN = 0;
  for (const p of prepared) {
    const productId = productIdByNorm.get(p.norm);
    if (!productId) {
      tracePush(opts, "batch_link_missing_product_id", { listingId: p.listingId, norm: p.norm });
      log("batch_link_missing_product_id", { listingId: p.listingId, norm: p.norm });
      out.errors.push({ stage: "missing_product_id", listingId: p.listingId, norm: p.norm });
      continue;
    }
    const applied = await applyListingProductLinkAndFinancialFlag(supabase, userId, p.listingId, productId);
    if (applied.ok) {
      if (linkTraceN < 25) {
        tracePush(opts, "marketplace_listing_product_id_set", {
          listingId: p.listingId,
          productId,
        });
        linkTraceN += 1;
      }
      out.listings_update_applied += 1;
      if (normsExistingBeforeCreate.has(p.norm)) {
        out.listings_linked_existing_product += 1;
      } else {
        out.listings_linked_new_product += 1;
      }
    } else {
      tracePush(opts, "marketplace_listing_product_id_failed", {
        listingId: p.listingId,
        productId,
        reason: applied.reason,
      });
      log("batch_link_listing_update_failed", {
        listingId: p.listingId,
        productId,
        reason: applied.reason,
      });
      out.errors.push({
        stage: "listing_product_update",
        listingId: p.listingId,
        productId,
        reason: applied.reason,
      });
    }
  }

  log("batch_products_done", {
    userId,
    ...out,
    errors_count: out.errors.length,
  });

  console.log("[ml/listing-product-link] batchEnsureProductsForListings DONE", {
    userId,
    products_created: out.products_created,
    listings_linked_existing_product: out.listings_linked_existing_product,
    listings_linked_new_product: out.listings_linked_new_product,
    listings_update_applied: out.listings_update_applied,
    listings_skipped_no_sku: out.listings_skipped_no_sku,
    errors_count: out.errors.length,
  });

  tracePush(opts, "batch_done", {
    products_created: out.products_created,
    listings_linked_existing_product: out.listings_linked_existing_product,
    listings_linked_new_product: out.listings_linked_new_product,
    listings_update_applied: out.listings_update_applied,
    listings_skipped_no_sku: out.listings_skipped_no_sku,
    errors_count: out.errors.length,
  });

  return out;
}

/**
 * Preenche product_id em anúncios já salvos (ex.: import incremental com new_count=0).
 * Usa raw_json armazenado em marketplace_listings.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   log?: (m: string, x?: object) => void;
 *   trace?: { at: string; event: string; [k: string]: unknown }[];
 * }} [opts]
 */
export async function backfillListingProductLinksFromRawJson(supabase, userId, opts = {}) {
  const log = opts.log || (() => {});
  tracePush(opts, "backfill_start", { userId });
  const aggregated = {
    loops: 0,
    rows_fetched: 0,
    rows_skipped_no_raw: 0,
    rows_skipped_invalid_item: 0,
    entries_with_seller_sku: 0,
    listings_marked_sku_pending: 0,
    products_created: 0,
    listings_linked_existing_product: 0,
    listings_linked_new_product: 0,
    listings_skipped_no_sku: 0,
    listings_entries_invalid: 0,
    listings_update_applied: 0,
    errors: /** @type {object[]} */ ([]),
  };

  /** @type {string | null} */
  let idAfter = null;

  for (let loop = 0; loop < BACKFILL_MAX_LOOPS; loop++) {
    let q = supabase
      .from("marketplace_listings")
      .select("id, raw_json")
      .eq("user_id", userId)
      .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
      .is("product_id", null)
      .order("id", { ascending: true })
      .limit(BACKFILL_LISTINGS_PAGE);

    if (idAfter) q = q.gt("id", idAfter);

    const { data: rows, error } = await q;

    if (error) {
      tracePush(opts, "backfill_select_error", { loop, error: tracePgErr(error) });
      log("backfill_select_error", { loop, error });
      aggregated.errors.push({ stage: "backfill_select", error });
      break;
    }
    if (!rows?.length) {
      tracePush(opts, "backfill_no_more_rows", { loop });
      log("backfill_no_more_rows", { loop });
      break;
    }

    aggregated.loops += 1;
    aggregated.rows_fetched += rows.length;

    /** @type {{ listingId: string; item: Record<string, unknown>; description: null }[]} */
    const entries = [];
    /** @type {string[]} */
    const idsSkuPending = [];

    for (const r of rows) {
      const raw = r.raw_json;
      if (!raw || typeof raw !== "object") {
        aggregated.rows_skipped_no_raw += 1;
        continue;
      }
      const item = /** @type {Record<string, unknown>} */ (raw);
      if (item.id == null) {
        aggregated.rows_skipped_invalid_item += 1;
        continue;
      }
      if (!extractSellerSku(item)) {
        idsSkuPending.push(String(r.id));
        continue;
      }
      entries.push({ listingId: String(r.id), item, description: null });
    }

    aggregated.entries_with_seller_sku += entries.length;

    tracePush(opts, "backfill_loop", {
      loop,
      rows_fetched: rows.length,
      entries_with_sku: entries.length,
      ids_mark_sku_pending: idsSkuPending.length,
      id_after: idAfter,
    });

    if (idsSkuPending.length > 0) {
      const pendingIso = new Date().toISOString();
      const { error: pendErr } = await supabase
        .from("marketplace_listings")
        .update({
          needs_attention: true,
          financial_analysis_blocked: true,
          attention_reason: ATTENTION_REASON_SKU_PENDING_ML,
          product_id: null,
          updated_at: pendingIso,
        })
        .eq("user_id", userId)
        .in("id", idsSkuPending)
        .is("product_id", null);

      if (pendErr) {
        tracePush(opts, "backfill_mark_sku_pending_failed", { error: tracePgErr(pendErr), count: idsSkuPending.length });
        log("backfill_mark_sku_pending_failed", { pendErr, count: idsSkuPending.length });
        aggregated.errors.push({ stage: "mark_sku_pending", error: pendErr });
      } else {
        aggregated.listings_marked_sku_pending += idsSkuPending.length;
      }
    }

    if (entries.length > 0) {
      const stats = await batchEnsureProductsForListings(supabase, userId, entries, { log, trace: opts.trace });

      aggregated.products_created += stats.products_created ?? 0;
      aggregated.listings_linked_existing_product += stats.listings_linked_existing_product ?? 0;
      aggregated.listings_linked_new_product += stats.listings_linked_new_product ?? 0;
      aggregated.listings_skipped_no_sku += stats.listings_skipped_no_sku ?? 0;
      aggregated.listings_entries_invalid += stats.listings_entries_invalid ?? 0;
      aggregated.listings_update_applied += stats.listings_update_applied ?? 0;
      if (stats.errors?.length) {
        aggregated.errors.push(...stats.errors.map((e) => ({ ...e, loop })));
      }

      const linked =
        (stats.listings_linked_existing_product ?? 0) + (stats.listings_linked_new_product ?? 0);
      if (linked === 0 && (stats.products_created ?? 0) === 0 && entries.length > 0) {
        tracePush(opts, "backfill_no_progress_break", {
          loop,
          entries: entries.length,
          listings_skipped_no_sku: stats.listings_skipped_no_sku,
        });
        log("backfill_no_progress_break", {
          loop,
          entries: entries.length,
          listings_skipped_no_sku: stats.listings_skipped_no_sku,
          errors_sample: stats.errors?.[0],
        });
        break;
      }
    }

    idAfter = String(rows[rows.length - 1].id);
    if (rows.length < BACKFILL_LISTINGS_PAGE) break;
  }

  tracePush(opts, "backfill_done", {
    loops: aggregated.loops,
    products_created: aggregated.products_created,
    listings_update_applied: aggregated.listings_update_applied,
    errors_count: aggregated.errors.length,
  });
  log("backfill_product_links_finished", aggregated);
  return aggregated;
}

/**
 * Caminho único (auto-sync / uso legado).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} description
 * @param {{ log?: (m: string, x?: object) => void }} [opts]
 */
export async function ensureListingLinkedToProduct(supabase, userId, listingId, item, description, opts = {}) {
  const r = await batchEnsureProductsForListings(
    supabase,
    userId,
    [{ listingId, item, description }],
    opts
  );
  const log = opts.log || (() => {});
  if (r.products_created || r.listings_linked_existing_product || r.listings_linked_new_product) {
    log("listing_product_batch_result_single", { listingId, ...r });
  }
}

/**
 * Libera anúncios quando produto fica completo (custos preenchidos).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 * @param {'complete' | 'incomplete_required_costs' | 'draft_imported_from_marketplace'} completeness
 */
export async function syncListingsFinancialBlockForProduct(supabase, userId, productId, completeness) {
  const blocked = completeness !== "complete";
  await supabase
    .from("marketplace_listings")
    .update({
      financial_analysis_blocked: blocked,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("product_id", productId);
}
