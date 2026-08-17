// ======================================================
// POST /api/ml/listings/set-sku
// Confirma SKU / vincula anúncio ao produto (mesmo padrão da importação).
// Funciona com raw_json parcial: injeta id ML + seller_sku + seller_custom_field.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { normalizeSkuForDbLookup } from "../../domain/productCatalogCompleteness.js";
import {
  applyListingProductLinkAndFinancialFlag,
  batchEnsureProductsForListings,
  resolveSkuForListingLink,
} from "./_helpers/mlListingProductLink.js";
import { extractSellerSku, ATTENTION_REASON_SKU_PENDING_ML } from "./_helpers/mlItemSkuExtract.js";

/** @param {unknown} errEntry */
function humanizeProductLinkError(errEntry) {
  const e = errEntry && typeof errEntry === "object" ? /** @type {Record<string, unknown>} */ (errEntry) : {};
  const stage = e.stage != null ? String(e.stage) : "";
  const reason = e.reason != null ? String(e.reason) : "";
  if (stage === "missing_product_id") {
    return "Não foi encontrado produto no seu catálogo com este SKU (incluindo variações). Cadastre o produto ou ajuste o SKU.";
  }
  if (stage === "listing_product_update" && reason === "zero_rows") {
    return "O vínculo foi resolvido, mas o banco não atualizou o anúncio (verifique se o anúncio pertence à sua conta).";
  }
  if (stage === "listing_product_update") {
    return "Falha ao gravar product_id no anúncio. Tente novamente ou contate o suporte.";
  }
  if (stage === "batch_insert_products") {
    return "Não foi possível criar o produto automático (erro ao inserir). Verifique duplicidade de SKU ou dados obrigatórios.";
  }
  return "";
}

async function syncMonitoredListingMirror({
  supabase,
  userId,
  listingId,
  fallbackSku,
  fallbackProductName,
}) {
  const { data: listingLinked, error: listingLinkedErr } = await supabase
    .from("marketplace_listings")
    .select("id, product_id, seller_sku")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (listingLinkedErr || !listingLinked) {
    if (listingLinkedErr) {
      console.error("[ml/listings/set-sku] listing_linked_read", listingLinkedErr);
    }
    return;
  }

  let productSku = null;
  let productName = null;
  if (listingLinked.product_id) {
    const { data: productRow, error: productErr } = await supabase
      .from("products")
      .select("id, sku, product_name")
      .eq("id", listingLinked.product_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (productErr) {
      console.error("[ml/listings/set-sku] product_read_for_monitored_sync", productErr);
    } else if (productRow) {
      productSku =
        productRow.sku != null && String(productRow.sku).trim() !== ""
          ? String(productRow.sku).trim()
          : null;
      productName =
        productRow.product_name != null && String(productRow.product_name).trim() !== ""
          ? String(productRow.product_name).trim()
          : null;
    }
  }

  const mirrorSku =
    productSku ||
    (listingLinked.seller_sku != null && String(listingLinked.seller_sku).trim() !== ""
      ? String(listingLinked.seller_sku).trim()
      : null) ||
    fallbackSku ||
    null;
  const mirrorName = productName || fallbackProductName || null;

  const { error: monitoredSyncErr } = await supabase
    .from("competition_monitored_listings")
    .update({
      product_id: listingLinked.product_id ?? null,
      sku: mirrorSku,
      product_name: mirrorName,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("marketplace_listing_id", listingId)
    .eq("is_monitored", true);

  if (monitoredSyncErr) {
    console.error("[ml/listings/set-sku] monitored_mirror_sync_error", monitoredSyncErr);
  }
}

export default async function handleMlListingSetSku(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  const listingId = body.listing_id != null ? String(body.listing_id).trim() : "";
  const sellerSkuFromBody = body.seller_sku != null ? String(body.seller_sku).trim() : "";
  const selectedProductId =
    body.selected_product_id != null ? String(body.selected_product_id).trim() : "";

  if (!listingId) {
    return res.status(400).json({
      ok: false,
      error: "Informe listing_id.",
    });
  }

  const { user, supabase } = auth;
  const userId = user.id;

  const { data: row, error: qErr } = await supabase
    .from("marketplace_listings")
    .select(
      "id, user_id, raw_json, external_listing_id, seller_sku, seller_custom_field, title, price",
    )
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (qErr || !row) {
    console.error("[ml/listings/set-sku] listing_query", qErr);
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }

  const fromDb =
    row.seller_custom_field != null && String(row.seller_custom_field).trim() !== ""
      ? String(row.seller_custom_field).trim()
      : row.seller_sku != null && String(row.seller_sku).trim() !== ""
        ? String(row.seller_sku).trim()
        : "";

  const effectiveSku = sellerSkuFromBody || fromDb;

  if (!effectiveSku) {
    return res.status(400).json({
      ok: false,
      error: "Informe o SKU ou sincronize o anúncio para trazer o SKU do Mercado Livre.",
    });
  }

  const norm = normalizeSkuForDbLookup(effectiveSku);
  if (!norm || norm.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "Informe um SKU válido.",
    });
  }

  if (selectedProductId) {
    const { data: selectedProduct, error: selectedProductErr } = await supabase
      .from("products")
      .select("id, product_name, sku, normalized_sku, product_variants ( sku )")
      .eq("id", selectedProductId)
      .eq("user_id", userId)
      .maybeSingle();

    if (selectedProductErr || !selectedProduct) {
      return res.status(422).json({
        ok: false,
        error: "Produto selecionado não encontrado para este usuário.",
      });
    }

    const productSkuMatch =
      normalizeSkuForDbLookup(selectedProduct.normalized_sku || "") === norm ||
      normalizeSkuForDbLookup(selectedProduct.sku || "") === norm;
    const variantSkuMatch = Array.isArray(selectedProduct.product_variants)
      ? selectedProduct.product_variants.some(
          (variant) => normalizeSkuForDbLookup(variant?.sku || "") === norm,
        )
      : false;

    if (!productSkuMatch && !variantSkuMatch) {
      return res.status(422).json({
        ok: false,
        error:
          "O produto selecionado não corresponde ao SKU informado. Selecione o produto correto antes de salvar.",
      });
    }

    const applied = await applyListingProductLinkAndFinancialFlag(
      supabase,
      userId,
      listingId,
      selectedProductId,
    );
    if (!applied.ok) {
      return res.status(500).json({
        ok: false,
        error: "Falha ao vincular anúncio ao produto selecionado.",
      });
    }
  }

  const extId = row.external_listing_id != null ? String(row.external_listing_id).trim() : "";

  /** @type {Record<string, unknown>} */
  const item =
    row.raw_json && typeof row.raw_json === "object" && !Array.isArray(row.raw_json)
      ? { .../** @type {Record<string, unknown>} */ (row.raw_json) }
      : {};

  if (!item.id && extId) {
    item.id = extId;
  }
  item.seller_custom_field = effectiveSku;
  item.seller_sku = effectiveSku;
  if (row.title != null && item.title == null) {
    item.title = row.title;
  }
  if (row.price != null && item.price == null) {
    item.price = row.price;
  }

  let resolvedSku = resolveSkuForListingLink(item, extId);
  if (!resolvedSku) {
    resolvedSku = extractSellerSku(item) || effectiveSku;
  }
  if (!resolvedSku || String(resolvedSku).trim() === "") {
    return res.status(422).json({
      ok: false,
      error: "Não foi possível resolver o SKU para vínculo. Verifique o anúncio e tente novamente.",
    });
  }

  let description = null;
  const { data: descRow } = await supabase
    .from("marketplace_listing_descriptions")
    .select("plain_text, html_text, raw_json")
    .eq("listing_id", listingId)
    .maybeSingle();

  if (descRow?.raw_json && typeof descRow.raw_json === "object") {
    description = /** @type {Record<string, unknown>} */ (descRow.raw_json);
  }

  try {
    const stats = selectedProductId
      ? {
          products_created: 0,
          listings_linked_existing_product: 1,
          listings_linked_new_product: 0,
          listings_skipped_no_sku: 0,
          listings_update_applied: 1,
          listings_entries_invalid: 0,
          errors: [],
          selected_product_id: selectedProductId,
        }
      : await batchEnsureProductsForListings(
          supabase,
          userId,
          [{ listingId: String(row.id), item, description }],
          { log: (m, x) => console.log("[ml/listings/set-sku]", m, x || {}) },
        );

    if (stats.errors?.length) {
      console.warn("[ml/listings/set-sku] product_link_errors", stats.errors);
      const hint = humanizeProductLinkError(stats.errors[0]);
      return res.status(422).json({
        ok: false,
        error: hint || "Não foi possível concluir o vínculo com o produto.",
        product_link: stats,
      });
    }

    const linked =
      (stats.listings_linked_existing_product ?? 0) + (stats.listings_linked_new_product ?? 0);
    if (linked === 0 && (stats.products_created ?? 0) === 0) {
      const noPrepared =
        (stats.listings_skipped_no_sku ?? 0) > 0 || (stats.listings_entries_invalid ?? 0) > 0;
      const msg = noPrepared
        ? "SKU inválido ou anúncio sem ID externo para vincular. Sincronize os anúncios e tente de novo."
        : "SKU não gerou vínculo. Confira se o produto existe no catálogo com o mesmo SKU ou se o anúncio está correto.";
      return res.status(422).json({
        ok: false,
        error: msg,
        product_link: stats,
      });
    }

    const pendingIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("marketplace_listings")
      .update({
        seller_sku: effectiveSku,
        seller_custom_field: effectiveSku,
        raw_json: item,
        needs_attention: false,
        attention_reason: null,
        updated_at: pendingIso,
      })
      .eq("id", listingId)
      .eq("user_id", userId);

    if (updErr) {
      console.error("[ml/listings/set-sku] listing_columns_update", updErr);
      return res.status(500).json({
        ok: false,
        error: "Produto vinculado, mas falhou ao atualizar colunas do anúncio.",
        product_link: stats,
      });
    }

    await syncMonitoredListingMirror({
      supabase,
      userId,
      listingId,
      fallbackSku: effectiveSku,
      fallbackProductName:
        row.title != null && String(row.title).trim() !== ""
          ? String(row.title).trim()
          : null,
    });

    return res.status(200).json({
      ok: true,
      message: "SKU confirmado e produto vinculado.",
      product_link: stats,
      attention_cleared: true,
      previous_attention: ATTENTION_REASON_SKU_PENDING_ML,
    });
  } catch (e) {
    console.error("[ml/listings/set-sku] fatal", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Erro ao processar SKU.",
    });
  }
}
