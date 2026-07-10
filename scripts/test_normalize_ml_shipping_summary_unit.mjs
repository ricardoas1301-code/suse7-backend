#!/usr/bin/env node
/**
 * S1.8 — Normalização shipping ML (Raio-X Anúncio) — testes de unidade.
 *   node scripts/test_normalize_ml_shipping_summary_unit.mjs
 */

import {
  buildEmptyMercadoLivreShippingSummary,
  normalizeMercadoLivreShippingSummary,
} from "../src/domain/listings/shipping/normalizeMercadoLivreShippingSummary.js";
import { normalizeMercadoLivreMediaSummary } from "../src/domain/listings/media/normalizeMercadoLivreMediaSummary.js";
import { normalizeMercadoLivrePriceSummary } from "../src/domain/listings/price/normalizeMercadoLivrePriceSummary.js";
import {
  inteiroNaoNegativoOuNull,
  normalizeListingVirtualStockSummary,
} from "../src/domain/listings/stock/normalizeListingVirtualStockSummary.js";
import { normalizeMercadoLivreWholesaleSummary } from "../src/domain/listings/wholesale/normalizeMercadoLivreWholesaleSummary.js";
import { buildListingImagesSummary } from "../src/domain/listings/images/buildListingImagesSummary.js";
import { resolveListingImagesPolicy } from "../src/domain/listings/images/resolveListingImagesPolicy.js";
import { extractCategoryPictureLimits } from "../src/domain/marketplaces/mercadoLivre/mercadoLivreCategoryPictures.js";
import { buildListingDescriptionSummary } from "../src/domain/listings/description/buildListingDescriptionSummary.js";
import { buildListingMeasurementsSummary } from "../src/domain/listings/measurements/buildListingMeasurementsSummary.js";
import { resolverImagemPrincipalListing, aplicarOrdemLocalNasImagensListing } from "../src/domain/listings/images/listingPictureKeys.js";

/** @type {string[]} */
const failures = [];
let passed = 0;

/**
 * @param {string} name
 * @param {boolean} cond
 */
function assert(name, cond) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(name);
  }
}

// Caso A — Tábua de Passar / RF Móveis (xd_drop_off + me2 + Flex via tag)
{
  const summary = normalizeMercadoLivreShippingSummary({
    tags: [],
    shipping: {
      mode: "me2",
      logistic_type: "xd_drop_off",
      free_shipping: true,
      tags: ["self_service_in"],
    },
  });

  assert("caso A: logistic_type_label Mercado Envios", summary.logistic_type_label === "Mercado Envios");
  assert("caso A: mode_label Mercado Envios", summary.mode_label === "Mercado Envios");
  assert("caso A: free_shipping_label Sim", summary.free_shipping_label === "Sim");
  assert("caso A: delivery_program_label Padrão / Flex", summary.delivery_program_label === "Padrão / Flex");
  assert("caso A: delivery_service_label Padrão / Flex", summary.delivery_service_label === "Padrão / Flex");
  assert("caso A: flex_label Sim", summary.flex_label === "Sim");
  assert("caso A: is_full false", summary.is_full === false);
  assert("caso A: is_flex true", summary.is_flex === true);
  assert("caso A: has_flex true", summary.has_flex === true);
  assert("caso A: mode_code preservado me2", summary.mode_code === "me2");
  assert("caso A: logistic_type_code preservado", summary.logistic_type_code === "xd_drop_off");
}

// Caso B — Escorredor / Super MetalRio (fulfillment + me2 + Flex)
{
  const summary = normalizeMercadoLivreShippingSummary({
    shipping: {
      mode: "me2",
      logistic_type: "fulfillment",
      free_shipping: true,
      tags: ["self_service_in"],
    },
  });

  assert("caso B: logistic_type_label Full", summary.logistic_type_label === "Full");
  assert("caso B: mode_label Mercado Envios", summary.mode_label === "Mercado Envios");
  assert("caso B: free_shipping_label Sim", summary.free_shipping_label === "Sim");
  assert("caso B: delivery_program_label Full / Flex", summary.delivery_program_label === "Full / Flex");
  assert("caso B: delivery_service_label Full / Flex", summary.delivery_service_label === "Full / Flex");
  assert("caso B: flex_label Sim", summary.flex_label === "Sim");
  assert("caso B: is_full true", summary.is_full === true);
  assert("caso B: is_flex true", summary.is_flex === true);
}

// Caso B variant — fulfillment sem Flex
{
  const summary = normalizeMercadoLivreShippingSummary({
    shipping: {
      mode: "me2",
      logistic_type: "fulfillment",
      free_shipping: true,
      tags: [],
    },
  });

  assert("caso B3: delivery_program_label Full", summary.delivery_program_label === "Full");
  assert("caso B3: flex_label Não", summary.flex_label === "Não");
  assert("caso B3: is_full true", summary.is_full === true);
  assert("caso B3: is_flex false", summary.is_flex === false);
}

// Caso 4 — self_service puro
{
  const summary = normalizeMercadoLivreShippingSummary({
    shipping: {
      mode: "me2",
      logistic_type: "self_service",
      free_shipping: false,
      tags: [],
    },
  });

  assert("caso 4: logistic_type_label Flex", summary.logistic_type_label === "Flex");
  assert("caso 4: free_shipping_label Não", summary.free_shipping_label === "Não");
  assert("caso 4: delivery_program_label Padrão / Flex", summary.delivery_program_label === "Padrão / Flex");
  assert("caso 4: flex_label Sim", summary.flex_label === "Sim");
}

// Caso C — sem Full e sem Flex
{
  const summary = normalizeMercadoLivreShippingSummary({
    shipping: {
      mode: "me2",
      logistic_type: "drop_off",
      free_shipping: true,
      tags: [],
    },
  });

  assert("caso C: delivery_program_label Padrão", summary.delivery_program_label === "Padrão");
  assert("caso C: flex_label Não", summary.flex_label === "Não");
  assert("caso C: is_full false", summary.is_full === false);
  assert("caso C: is_flex false", summary.is_flex === false);
}

// Regra crítica — me2 sozinho NUNCA produz Full
{
  const summary = normalizeMercadoLivreShippingSummary({
    shipping: {
      mode: "me2",
      logistic_type: "xd_drop_off",
      free_shipping: true,
      tags: [],
    },
  });

  assert("me2 sozinho: is_full false", summary.is_full === false);
  assert("me2 sozinho: delivery_program_label Padrão", summary.delivery_program_label === "Padrão");
  assert("me2 sozinho: flex_label Não", summary.flex_label === "Não");
  assert("me2 sozinho: mode_label Mercado Envios", summary.mode_label === "Mercado Envios");
  assert("me2 sozinho: nunca exibe full no programa", summary.delivery_program_label !== "Full");
}

// shipping_mode legado no item NÃO deve inferir Full (regressão bug adapter)
{
  const summary = normalizeMercadoLivreShippingSummary({
    shipping_mode: "me2",
    fulfillment: "full",
    shipping: {
      mode: "me2",
      logistic_type: "xd_drop_off",
      free_shipping: true,
      tags: ["self_service_in"],
    },
  });

  assert("regressão shipping_mode: is_full false", summary.is_full === false);
  assert("regressão shipping_mode: delivery Padrão / Flex", summary.delivery_program_label === "Padrão / Flex");
  assert("regressão shipping_mode: flex Sim", summary.flex_label === "Sim");
}

// Caso D — payload vazio
{
  const summary = normalizeMercadoLivreShippingSummary(null);
  const empty = buildEmptyMercadoLivreShippingSummary();

  assert("caso D: logistic_type_label Não informado", summary.logistic_type_label === "Não informado");
  assert("caso D: mode_label Não informado", summary.mode_label === "Não informado");
  assert("caso D: free_shipping_label —", summary.free_shipping_label === "—");
  assert("caso D: delivery_program_label Não informado", summary.delivery_program_label === "Não informado");
  assert("caso D: flex_label —", summary.flex_label === "—");
  assert("caso D: is_full null", summary.is_full === null);
  assert("caso D: has_flex null", summary.has_flex === null);
  assert("caso D: source unknown", summary.source_confidence === "unknown");
  assert("caso D: empty factory", empty.delivery_program_label === "Não informado");
}

// Labels amigáveis — nunca código cru na UI
{
  const summary = normalizeMercadoLivreShippingSummary({
    shipping: {
      mode: "me2",
      logistic_type: "xd_drop_off",
      free_shipping: true,
      tags: [],
    },
  });

  assert("UI: logistic_type_label não é xd_drop_off", summary.logistic_type_label !== "xd_drop_off");
  assert("UI: mode_label não é me2", summary.mode_label !== "me2");
  assert("UI: delivery não é fulfillment", summary.delivery_program_label !== "fulfillment");
}

// Media — video_id presente
{
  const summary = normalizeMercadoLivreMediaSummary({
    item_full_detail: { ok: true, status: 200, data: { video_id: "abc123" } },
  });
  assert("media: video_id => 1 clip", summary.clips_count === 1);
  assert("media: video_id label 1", summary.clips_label === "1");
  assert("media: video_id source", summary.source === "item_video_id");
  assert("media: video_id confidence", summary.source_confidence === "api_verified");
  assert("media: video_id has clips", summary.has_clips === true);
}

// Media — arrays de mídia
{
  const clipsSummary = normalizeMercadoLivreMediaSummary({
    item_full_detail: { ok: true, status: 200, data: { clips: [{ id: "1" }, { id: "2" }] } },
  });
  const videosSummary = normalizeMercadoLivreMediaSummary({
    item_full_detail: { ok: true, status: 200, data: { videos: [{ id: "1" }] } },
  });
  assert("media: clips array 2", clipsSummary.clips_count === 2);
  assert("media: videos array 1", videosSummary.clips_count === 1);
  assert("media: clips source", clipsSummary.source === "item_media_array");
  assert("media: videos source", videosSummary.source === "item_media_array");
}

// Media — item sem vídeo verificado
{
  const summary = normalizeMercadoLivreMediaSummary({
    item_full_detail: { ok: true, status: 200, data: { title: "Sem vídeo" } },
  });
  assert("media: item sem vídeo => 0", summary.clips_count === 0);
  assert("media: item sem vídeo source", summary.source === "item_without_video");
  assert("media: item sem vídeo confidence", summary.source_confidence === "api_verified");
}

// Media — API falhou
{
  const summary = normalizeMercadoLivreMediaSummary({
    item_full_detail: { ok: false, status: 403, data: null, error_code: "forbidden" },
  });
  assert("media: api erro => 0", summary.clips_count === 0);
  assert("media: api erro source", summary.source === "api_error");
  assert("media: api erro confidence", summary.source_confidence === "unknown");
}

// Wholesale — atacado ativo com Decimal/string
{
  const summary = normalizeMercadoLivreWholesaleSummary({
    item_prices_show_all: {
      ok: true,
      status: 200,
      show_all_prices_sent: true,
      data: {
        prices: [
          {
            type: "standard",
            amount: "256.90",
            currency_id: "BRL",
            conditions: {
              min_purchase_unit: "2",
              context_restrictions: ["channel_marketplace", "user_type_business"],
            },
          },
        ],
      },
    },
  });
  assert("wholesale: enabled", summary.enabled === true);
  assert("wholesale: min quantity string", summary.min_quantity === "2");
  assert("wholesale: price string", summary.unit_price_brl === "256.90");
  assert("wholesale: label BRL", summary.label === "R$ 256,90");
  assert("wholesale: tiers_count", summary.tiers_count === 1);
  assert("wholesale: source show all", summary.source === "item_prices_show_all");
  assert("wholesale: decimal string sem float", typeof summary.unit_price_brl === "string");
}

// Preço de venda — rawItem.price válido
{
  const summary = normalizeMercadoLivrePriceSummary({ price: "269.90" });
  assert("price: sale_price_brl string", summary.sale_price_brl === "269.90");
  assert("price: sale_price_label BRL", summary.sale_price_label === "R$ 269,90");
  assert("price: source raw_item_price", summary.source === "raw_item_price");
  assert("price: confidence raw_ml_payload", summary.source_confidence === "raw_ml_payload");
  assert("price: sem float", typeof summary.sale_price_brl === "string");
}

// Preço de venda — ausente
{
  const summary = normalizeMercadoLivrePriceSummary({});
  assert("price: ausente label dash", summary.sale_price_label === "—");
  assert("price: ausente null", summary.sale_price_brl === null);
}

// Preço de venda — preserva centavos
{
  const summary = normalizeMercadoLivrePriceSummary({ price: "1234.50" });
  assert("price: centavos preservados", summary.sale_price_brl === "1234.50");
  assert("price: label milhar BRL", summary.sale_price_label === "R$ 1.234,50");
}

// Wholesale — escolhe menor quantidade mínima
{
  const summary = normalizeMercadoLivreWholesaleSummary({
    item_prices_show_all: {
      ok: true,
      status: 200,
      show_all_prices_sent: true,
      data: {
        prices: [
          {
            type: "standard",
            amount: "199.99",
            currency_id: "BRL",
            conditions: {
              min_purchase_unit: "5",
              context_restrictions: ["channel_marketplace", "user_type_business"],
            },
          },
          {
            type: "standard",
            amount: "256.90",
            currency_id: "BRL",
            conditions: {
              min_purchase_unit: "2",
              context_restrictions: ["channel_marketplace", "user_type_business"],
            },
          },
        ],
      },
    },
  });
  assert("wholesale: menor faixa por quantidade", summary.min_quantity === "2");
  assert("wholesale: menor faixa preço", summary.unit_price_brl === "256.90");
  assert("wholesale: múltiplas faixas count", summary.tiers_count === 2);
}

// Wholesale — standard sem min_purchase_unit não é atacado
{
  const summary = normalizeMercadoLivreWholesaleSummary({
    item_prices_show_all: {
      ok: true,
      status: 200,
      show_all_prices_sent: true,
      data: {
        prices: [
          {
            type: "standard",
            amount: "123.45",
            currency_id: "BRL",
            conditions: { context_restrictions: ["channel_marketplace", "user_type_business"] },
          },
        ],
      },
    },
  });
  assert("wholesale: sem min_purchase_unit disabled", summary.enabled === false);
  assert("wholesale: sem min_purchase_unit source", summary.source === "item_without_quantity_price");
}

// Wholesale — min_purchase_unit = 1 não é atacado
{
  const summary = normalizeMercadoLivreWholesaleSummary({
    item_prices_show_all: {
      ok: true,
      status: 200,
      show_all_prices_sent: true,
      data: {
        prices: [
          {
            type: "standard",
            amount: "123.45",
            currency_id: "BRL",
            conditions: {
              min_purchase_unit: "1",
              context_restrictions: ["channel_marketplace", "user_type_business"],
            },
          },
        ],
      },
    },
  });
  assert("wholesale: min 1 disabled", summary.enabled === false);
}

// Wholesale — sem user_type_business não é atacado
{
  const summary = normalizeMercadoLivreWholesaleSummary({
    item_prices_show_all: {
      ok: true,
      status: 200,
      show_all_prices_sent: true,
      data: {
        prices: [
          {
            type: "standard",
            amount: "123.45",
            currency_id: "BRL",
            conditions: {
              min_purchase_unit: "2",
              context_restrictions: ["channel_marketplace"],
            },
          },
        ],
      },
    },
  });
  assert("wholesale: sem B2B disabled", summary.enabled === false);
}

// Wholesale — sem atacado
{
  const summary = normalizeMercadoLivreWholesaleSummary({
    item_prices_show_all: { ok: true, status: 200, show_all_prices_sent: true, data: { prices: [] } },
  });
  assert("wholesale: disabled", summary.enabled === false);
  assert("wholesale: label sem atacado", summary.label === "Não vende no atacado");
  assert("wholesale: tiers_count zero", summary.tiers_count === 0);
  assert("wholesale: source sem quantity", summary.source === "item_without_quantity_price");
}

// Wholesale — API falhou
{
  const summary = normalizeMercadoLivreWholesaleSummary({
    item_prices_show_all: {
      ok: false,
      status: 429,
      data: null,
      error_code: "rate_limit",
      show_all_prices_sent: true,
    },
  });
  assert("wholesale: api error disabled", summary.enabled === false);
  assert("wholesale: api error source", summary.source === "api_error");
  assert("wholesale: api error confidence", summary.source_confidence === "unknown");
}

// S1.14 — estoque virtual: produto 300, listing sem override
{
  const summary = normalizeListingVirtualStockSummary({
    product_virtual_stock_enabled: true,
    product_virtual_stock_value: 300,
    listing_virtual_stock_override_enabled: false,
    listing_virtual_stock_value: null,
  });
  assert("virtual stock: herda produto 300", summary.effective_virtual_stock_value === 300);
  assert("virtual stock: source product_default", summary.effective_virtual_stock_source === "product_default");
}

// S1.14 — produto 300, listing override 200
{
  const summary = normalizeListingVirtualStockSummary({
    product_virtual_stock_enabled: true,
    product_virtual_stock_value: 300,
    listing_virtual_stock_override_enabled: true,
    listing_virtual_stock_value: 200,
  });
  assert("virtual stock: override 200", summary.effective_virtual_stock_value === 200);
  assert("virtual stock: source listing_override", summary.effective_virtual_stock_source === "listing_override");
}

// S1.14 — produto sem virtual stock, listing override 50
{
  const summary = normalizeListingVirtualStockSummary({
    product_virtual_stock_enabled: false,
    product_virtual_stock_value: null,
    listing_virtual_stock_override_enabled: true,
    listing_virtual_stock_value: 50,
  });
  assert("virtual stock: override sem produto 50", summary.effective_virtual_stock_value === 50);
  assert("virtual stock: override sem produto source", summary.effective_virtual_stock_source === "listing_override");
}

// S1.14 — produto sem virtual stock, listing sem override
{
  const summary = normalizeListingVirtualStockSummary({
    product_virtual_stock_enabled: false,
    product_virtual_stock_value: null,
    listing_virtual_stock_override_enabled: false,
    listing_virtual_stock_value: null,
  });
  assert("virtual stock: none value null", summary.effective_virtual_stock_value === null);
  assert("virtual stock: none source", summary.effective_virtual_stock_source === "none");
}

// S1.14 — override desligado limpa valor e herda produto
{
  const summary = normalizeListingVirtualStockSummary({
    product_virtual_stock_enabled: true,
    product_virtual_stock_value: 300,
    listing_virtual_stock_override_enabled: false,
    listing_virtual_stock_value: 200,
  });
  assert("virtual stock: override desligado valor null", summary.listing_virtual_stock_value === null);
  assert("virtual stock: override desligado herda", summary.effective_virtual_stock_value === 300);
}

// S1.14 — validação de inteiro seguro
{
  assert("virtual stock: inteiro 0 válido", inteiroNaoNegativoOuNull("0") === 0);
  assert("virtual stock: negativo inválido", inteiroNaoNegativoOuNull("-1") === null);
  assert("virtual stock: decimal inválido", inteiroNaoNegativoOuNull("10.5") === null);
  assert("virtual stock: texto inválido", inteiroNaoNegativoOuNull("abc") === null);
}

// S1.19 — política de imagens por categoria ML
{
  const limits = extractCategoryPictureLimits({
    name: "Tábuas de Passar",
    settings: {
      max_pictures_per_item: 12,
      max_pictures_per_item_var: 10,
    },
  });
  assert("images policy: max item 12", limits.max_pictures_per_item === 12);
  assert("images policy: max var 10", limits.max_pictures_per_item_var === 10);
  assert("images policy: category name", limits.category_name === "Tábuas de Passar");
}

// S1.19 — resolveListingImagesPolicy sem token retorna confidence none
{
  const policy = await resolveListingImagesPolicy({
    marketplace: "mercado_livre",
    categoryId: "MLB123",
    hasVariations: false,
    accessToken: null,
  });
  assert("images policy: sem token max null", policy.displayMaxPictures === null);
  assert("images policy: sem token confidence none", policy.confidence === "none");
}

// S1.19 — buildListingImagesSummary normaliza pictures e policy
{
  const summary = buildListingImagesSummary({
    pictures: [{ url: "https://example.com/a.jpg", position: 1 }, { secure_url: "https://example.com/b.jpg" }],
    policy: {
      marketplace: "mercado_livre",
      maxPicturesPerItem: 12,
      maxPicturesPerVariation: 10,
      displayMaxPictures: 12,
      categoryName: "Categoria teste",
      source: "category_settings",
      confidence: "high",
      hasVariations: false,
    },
    categoryId: "MLB123",
    categoryName: "Categoria teste",
  });
  assert("images summary: pictures_count 2", summary.pictures_count === 2);
  assert("images summary: max item 12", summary.max_pictures_per_item === 12);
  assert("images summary: policy maxPictures 12", summary.images_policy.maxPictures === 12);
  assert("images summary: source category_settings", summary.images_policy.source === "category_settings");
}

// S1.21 — imagem principal por anúncio (chave estável + override local)
{
  const pictures = [
    { picture_id: "PIC-1", url: "https://example.com/1.jpg", position: 0 },
    { picture_id: "PIC-2", url: "https://example.com/2.jpg", position: 1 },
  ];
  const resolved = resolverImagemPrincipalListing(pictures, {
    primary_picture_id: "PIC-2",
    primary_picture_url: "https://example.com/2.jpg",
  });
  assert("primary picture: override by id", resolved.picture_id === "PIC-2");
  assert("primary picture: override source", resolved.source === "listing_override");
  assert("primary picture: stable key id", resolved.stable_key === "id:PIC-2");

  const defaultPrimary = resolverImagemPrincipalListing(pictures, null);
  assert("primary picture: default first", defaultPrimary.picture_id === "PIC-1");
  assert("primary picture: default source", defaultPrimary.source === "marketplace_default");
}

// S1.22 — ordem local das imagens do anúncio
{
  const pictures = [
    { picture_id: "PIC-1", url: "https://example.com/1.jpg", position: 0 },
    { picture_id: "PIC-2", url: "https://example.com/2.jpg", position: 1 },
    { picture_id: "PIC-3", url: "https://example.com/3.jpg", position: 2 },
  ];
  const applied = aplicarOrdemLocalNasImagensListing(pictures, {
    ordered_picture_keys: ["id:PIC-3", "id:PIC-1", "id:PIC-2"],
  });
  assert("picture order: local_order source", applied.effective_primary_source === "local_order");
  assert("picture order: first is PIC-3", applied.effective_primary_picture_id === "PIC-3");
  assert("picture order: keys persisted", applied.ordered_picture_keys.join(",") === "id:PIC-3,id:PIC-1,id:PIC-2");
  assert("picture order: positions reindexed", applied.pictures[2]?.picture_id === "PIC-2");
}

// S1.23 — description_summary local override
{
  const local = buildListingDescriptionSummary({
    marketplaceDescription: "Texto do Mercado Livre",
    localDescription: "Texto editado no SUS7",
  });
  assert("description: local override source", local.effective_source === "local_override");
  assert("description: local effective text", local.effective_description === "Texto editado no SUS7");
  assert("description: marketplace preserved", local.marketplace_description === "Texto do Mercado Livre");

  const marketplaceOnly = buildListingDescriptionSummary({
    marketplaceDescription: "Somente ML",
    localDescription: null,
  });
  assert("description: marketplace default source", marketplaceOnly.effective_source === "marketplace_default");
  assert("description: marketplace effective text", marketplaceOnly.effective_description === "Somente ML");

  const empty = buildListingDescriptionSummary({
    marketplaceDescription: null,
    localDescription: null,
  });
  assert("description: none source", empty.effective_source === "none");
  assert("description: empty effective", empty.effective_description === "");
}

// S1.24 — measurements_summary local override + fallback
{
  const summary = buildListingMeasurementsSummary({
    marketplaceMeasurements: {
      shipping: { width_cm: 10, height_cm: 20, length_cm: 30, weight_kg: 1.5 },
      product_mounted: { width_cm: null, height_cm: null, length_cm: null, weight_kg: null },
    },
    productMeasurements: {
      shipping: { width_cm: 11, height_cm: 21, length_cm: 31, weight_kg: 1.6 },
      product_mounted: { width_cm: 50, height_cm: 60, length_cm: 70, weight_kg: 2.5 },
    },
    localMeasurements: {
      shipping: { width_cm: 12, height_cm: null, length_cm: null, weight_kg: null },
      product_mounted: { width_cm: null, height_cm: null, length_cm: null, weight_kg: null },
    },
  });
  assert("measurements: local width", summary.shipping.width_cm === 12);
  assert("measurements: marketplace height fallback", summary.shipping.height_cm === 20);
  assert("measurements: product mounted fallback", summary.product_mounted.width_cm === 50);
  assert("measurements: mixed source", summary.effective_source === "mixed");
}

console.log(`\nS1 listing summary KPI normalizers — ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("Failures:");
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}

console.log("OK — me2 não é mais usado para inferir Full.\n");
