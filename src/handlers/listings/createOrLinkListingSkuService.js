import { normalizeSkuForDbLookup } from "../../domain/productCatalogCompleteness.js";
import {
  applyListingProductLinkAndFinancialFlag,
  batchEnsureProductsForListings,
} from "../ml/_helpers/mlListingProductLink.js";
import { syncListingHealthProductSnapshot } from "../ml/_helpers/syncListingHealthProductSnapshot.js";

/** @param {Record<string, unknown>} row @param {string} sku */
export function buildListingItemWithSku(row, sku) {
  const raw =
    row.raw_json && typeof row.raw_json === "object" && !Array.isArray(row.raw_json)
      ? { ...row.raw_json }
      : {};
  if (!raw.id && row.external_listing_id) raw.id = row.external_listing_id;
  raw.seller_custom_field = sku;
  raw.seller_sku = sku;
  if (raw.title == null && row.title != null) raw.title = row.title;
  if (raw.price == null && row.price != null) raw.price = row.price;
  return raw;
}

/**
 * Retorna todos os candidatos do tenant; mais de um é ambiguidade explícita.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} normalizedSku
 */
export async function loadProductCandidatesByNormalizedSkus(
  supabase,
  userId,
  normalizedSkus,
) {
  const norms = new Set(
    (normalizedSkus || []).map((sku) => normalizeSkuForDbLookup(sku)).filter(Boolean),
  );
  const candidatesByNorm = new Map([...norms].map((norm) => [norm, new Set()]));
  const { data: products, error: productError } = await supabase
    .from("products")
    .select("id, sku, normalized_sku")
    .eq("user_id", userId);
  if (productError) throw productError;

  const productIds = [];
  for (const product of products || []) {
    if (!product?.id) continue;
    productIds.push(product.id);
    const productNorms = new Set([
      normalizeSkuForDbLookup(product.normalized_sku || ""),
      normalizeSkuForDbLookup(product.sku || ""),
    ]);
    for (const norm of productNorms) {
      if (norms.has(norm)) candidatesByNorm.get(norm)?.add(String(product.id));
    }
  }

  if (productIds.length > 0) {
    const { data: variants, error: variantError } = await supabase
      .from("product_variants")
      .select("product_id, sku")
      .in("product_id", productIds);
    if (variantError) throw variantError;
    for (const variant of variants || []) {
      const norm = normalizeSkuForDbLookup(variant?.sku || "");
      if (variant?.product_id && norms.has(norm)) {
        candidatesByNorm.get(norm)?.add(String(variant.product_id));
      }
    }
  }
  return new Map(
    [...candidatesByNorm].map(([norm, candidates]) => [norm, [...candidates]]),
  );
}

export async function findProductCandidatesBySku(supabase, userId, normalizedSku) {
  const normalized = normalizeSkuForDbLookup(normalizedSku);
  if (!normalized) return [];
  const candidatesByNorm = await loadProductCandidatesByNormalizedSkus(
    supabase,
    userId,
    [normalized],
  );
  return candidatesByNorm.get(normalized) || [];
}

async function syncMonitoredMirror(supabase, userId, row, productId, sku) {
  let productName = row.title || null;
  let productSku = sku;
  const { data: product } = await supabase
    .from("products")
    .select("sku, product_name")
    .eq("id", productId)
    .eq("user_id", userId)
    .maybeSingle();
  if (product) {
    productSku = product.sku || sku;
    productName = product.product_name || productName;
  }
  const { error } = await supabase
    .from("competition_monitored_listings")
    .update({
      product_id: productId,
      sku: productSku,
      product_name: productName,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("marketplace_listing_id", row.id)
    .eq("is_monitored", true);
  if (error) console.warn("[listing-sku] monitored_mirror_soft_fail", { listingId: row.id });
}

async function insertAudit(supabase, userId, row, reason) {
  try {
    const { error } = await supabase.from("marketplace_listing_change_events").insert({
      listing_id: row.id,
      user_id: userId,
      marketplace: row.marketplace,
      external_listing_id: String(row.external_listing_id || "unknown"),
      reason,
      changed_fields: ["seller_sku", "seller_custom_field", "product_id"],
    });
    if (error) {
      console.warn("[listing-sku] audit_soft_fail", {
        listingId: row.id,
        message: error.message,
      });
    }
  } catch (error) {
    console.warn("[listing-sku] audit_soft_fail", { listingId: row.id, message: error?.message });
  }
}

export function prepareListingSkuLink(input) {
  const { row } = input;
  const existingSku = String(row.seller_custom_field || row.seller_sku || "").trim();
  const sku = String(input.skuRaw || existingSku).trim();
  const normalizedSku = normalizeSkuForDbLookup(sku);
  if (!normalizedSku) {
    return { ok: false, code: "INVALID_SKU", status: 400, message: "Informe um SKU válido." };
  }

  const candidates = input.candidates || [];
  const selectedProductId = String(input.selectedProductId || "").trim();
  let productId = null;
  if (selectedProductId) {
    if (!candidates.includes(selectedProductId)) {
      return {
        ok: false,
        code: "SELECTED_PRODUCT_SKU_MISMATCH",
        status: 422,
        message: "O produto selecionado não corresponde ao SKU informado ou não pertence ao usuário.",
      };
    }
    productId = selectedProductId;
  } else if (candidates.length > 1) {
    return {
      ok: false,
      code: "CONFLICT",
      status: 409,
      message: "Mais de um produto corresponde ao SKU. Informe selected_product_id.",
      candidate_product_ids: candidates,
    };
  } else if (candidates.length === 1) {
    productId = candidates[0];
  }

  const item = buildListingItemWithSku(row, sku);
  return { ok: true, row, sku, normalizedSku, item, productId };
}

/**
 * Finaliza um vínculo já resolvido; `linkAlreadyApplied` é usado pelo batch
 * canônico, que grava product_id internamente.
 */
export async function finalizeListingSkuLink(input) {
  const { supabase, userId, row, sku, normalizedSku, item, productId } = input;
  if (!input.linkAlreadyApplied) {
    const applied = await applyListingProductLinkAndFinancialFlag(
      supabase,
      userId,
      String(row.id),
      productId,
    );
    if (!applied.ok) {
      return { ok: false, code: "LINK_FAILED", status: 500, message: "Falha ao vincular anúncio ao produto." };
    }
  }

  const { error: updateError } = await supabase
    .from("marketplace_listings")
    .update({
      seller_sku: sku,
      seller_custom_field: sku,
      raw_json: item,
      needs_attention: false,
      attention_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("user_id", userId);
  if (updateError) {
    return {
      ok: false,
      code: "LISTING_COLUMNS_UPDATE_FAILED",
      status: 500,
      message: "Produto vinculado, mas falhou ao atualizar o anúncio.",
    };
  }

  await Promise.allSettled([
    syncMonitoredMirror(supabase, userId, row, productId, sku),
    insertAudit(supabase, userId, row, input.auditReason || "set_sku"),
    row.external_listing_id
      ? syncListingHealthProductSnapshot(
          supabase,
          userId,
          String(row.marketplace || "mercado_livre"),
          row.external_listing_id,
          { product_id: productId, attention_reason: null },
        )
      : Promise.resolve(),
  ]);
  return {
    ok: true,
    status: 200,
    code: input.created ? "PRODUCT_CREATED" : "PRODUCT_LINKED",
    listing_id: row.id,
    external_listing_id: row.external_listing_id,
    product_id: productId,
    sku,
    normalized_sku: normalizedSku,
    product_created: Boolean(input.created),
  };
}

/**
 * Serviço canônico create-or-link usado pelo fluxo individual. O v2 reutiliza
 * a mesma preparação/finalização e agrega apenas a fase batch.
 */
export async function createOrLinkListingSku(input) {
  const { supabase, userId, row } = input;
  const existingSku = String(row.seller_custom_field || row.seller_sku || "").trim();
  const normalizedSku = normalizeSkuForDbLookup(input.skuRaw || existingSku);
  if (!normalizedSku) {
    return { ok: false, code: "INVALID_SKU", status: 400, message: "Informe um SKU válido." };
  }

  let candidates;
  try {
    candidates = await findProductCandidatesBySku(supabase, userId, normalizedSku);
  } catch {
    return { ok: false, code: "CATALOG_QUERY_FAILED", status: 500, message: "Falha ao consultar catálogo." };
  }
  const prepared = prepareListingSkuLink({ ...input, candidates });
  if (!prepared.ok) return prepared;

  if (prepared.productId) {
    return finalizeListingSkuLink({ ...input, ...prepared });
  }

  const batchEnsure = input.batchEnsureProductsForListingsFn || batchEnsureProductsForListings;
  const stats = await batchEnsure(
    supabase,
    userId,
    [{ listingId: String(row.id), item: prepared.item, description: null }],
    { log: () => {} },
  );
  const entry = stats.entry_results?.find(
    (result) => String(result.listing_id) === String(row.id),
  );
  if (!entry?.ok || !entry.product_id) {
    return {
      ok: false,
      code: "CREATE_OR_LINK_FAILED",
      status: 422,
      message: "Não foi possível criar ou vincular o produto para este SKU.",
      product_link: stats,
    };
  }
  return finalizeListingSkuLink({
    ...input,
    ...prepared,
    productId: entry.product_id,
    created: entry.created,
    linkAlreadyApplied: true,
  });
}
