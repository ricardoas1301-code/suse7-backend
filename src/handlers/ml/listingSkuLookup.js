// ======================================================
// GET /api/ml/listings/sku-lookup
// Busca produtos do seller por SKU normalizado (produto/variação).
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { normalizeSkuForDbLookup } from "../../domain/productCatalogCompleteness.js";

/**
 * @param {{
 *   id: string;
 *   product_name?: string | null;
 *   sku?: string | null;
 *   product_images?: unknown;
 *   product_image_links?: unknown;
 * }} row
 */
function mapProdutoResumo(row) {
  return {
    id: String(row?.id || ""),
    product_name: row?.product_name != null ? String(row.product_name) : "Produto sem nome",
    sku: row?.sku != null ? String(row.sku).trim() || null : null,
    product_images: Array.isArray(row?.product_images) || typeof row?.product_images === "string"
      ? row.product_images
      : null,
    product_image_links: Array.isArray(row?.product_image_links) ? row.product_image_links : [],
  };
}

export default async function handleMlListingSkuLookup(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido." });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const rawSku = req.query?.sku != null ? String(req.query.sku).trim() : "";
  if (!rawSku) {
    return res.status(400).json({ ok: false, error: "Informe o SKU para busca." });
  }

  const normalizedSku = normalizeSkuForDbLookup(rawSku);
  if (!normalizedSku) {
    return res.status(400).json({ ok: false, error: "SKU inválido para busca." });
  }

  const { supabase, user } = auth;
  const userId = user.id;

  /** @type {Map<string, { id: string; product_name?: string | null; sku?: string | null; matched_by: "product" | "variant"; matched_variant_sku?: string | null }>} */
  const resultadoPorProduto = new Map();

  const { data: byNormalized, error: byNormalizedErr } = await supabase
    .from("products")
    .select("id, product_name, sku, product_images, product_image_links(storage_path, variant_key, sort_order, is_primary)")
    .eq("user_id", userId)
    .eq("normalized_sku", normalizedSku)
    .limit(8);

  if (byNormalizedErr) {
    console.error("[ml/listings/sku-lookup] products normalized_sku query error", byNormalizedErr);
    return res.status(500).json({ ok: false, error: "Falha ao buscar produtos por SKU." });
  }

  for (const row of byNormalized || []) {
    const id = String(row?.id || "");
    if (!id) continue;
    resultadoPorProduto.set(id, {
      ...mapProdutoResumo(row),
      matched_by: "product",
      matched_variant_sku: null,
    });
  }

  const { data: variantsEq, error: variantsErr } = await supabase
    .from("product_variants")
    .select("product_id, sku")
    .ilike("sku", rawSku)
    .limit(30);

  if (variantsErr) {
    console.error("[ml/listings/sku-lookup] product_variants query error", variantsErr);
    return res.status(500).json({ ok: false, error: "Falha ao buscar variações por SKU." });
  }

  const variantHits = (variantsEq || []).filter((row) => {
    const sku = row?.sku != null ? String(row.sku) : "";
    return normalizeSkuForDbLookup(sku) === normalizedSku;
  });

  const missingProductIds = [
    ...new Set(
      variantHits
        .map((row) => (row?.product_id != null ? String(row.product_id).trim() : ""))
        .filter(Boolean)
        .filter((id) => !resultadoPorProduto.has(id)),
    ),
  ];

  if (missingProductIds.length > 0) {
    const { data: variantProducts, error: variantProductsErr } = await supabase
      .from("products")
      .select("id, product_name, sku, product_images, product_image_links(storage_path, variant_key, sort_order, is_primary)")
      .eq("user_id", userId)
      .in("id", missingProductIds)
      .limit(12);

    if (variantProductsErr) {
      console.error("[ml/listings/sku-lookup] products by variant ids query error", variantProductsErr);
      return res.status(500).json({ ok: false, error: "Falha ao resolver produtos por variação." });
    }

    const variantSkuByProductId = new Map();
    for (const hit of variantHits) {
      const pid = hit?.product_id != null ? String(hit.product_id).trim() : "";
      if (!pid || variantSkuByProductId.has(pid)) continue;
      variantSkuByProductId.set(pid, hit?.sku != null ? String(hit.sku).trim() : null);
    }

    for (const row of variantProducts || []) {
      const id = String(row?.id || "");
      if (!id) continue;
      resultadoPorProduto.set(id, {
        ...mapProdutoResumo(row),
        matched_by: "variant",
        matched_variant_sku: variantSkuByProductId.get(id) ?? null,
      });
    }
  }

  const products = [...resultadoPorProduto.values()].slice(0, 8);

  return res.status(200).json({
    ok: true,
    sku_input: rawSku,
    sku_normalized: normalizedSku,
    total: products.length,
    products,
  });
}

