// ======================================================
// ⚠️ Este módulo segue o Suse7 Pricing Protocol v1. Antes de alterar lógica de preço/promo/payout,
// consulte: docs/adr/ADR-0001-pricing-contract-v1.md e docs/SUSE7_PRICING_PROTOCOL_V1.md
// ======================================================
// Mercado Livre — shape normalizado para a grid de anúncios (GET /api/ml/listings).
// Contrato de pricing: docs/SUSE7_PRICING_PROTOCOL_V1.md (listingGridAssembler + ensureListingGridMoneyContract).
// Tipos de anúncio: https://api.mercadolibre.com/sites/MLB/listing_types (gold_special, gold_pro, etc.)
//
// Origem das colunas (regra de negócio):
// - Faturamento exibido (coluna): listing_sales_metrics.gross_revenue_total (pedidos importados — AGREGADO).
// - “Você recebe” (repasse unitário): somente `marketplace_listing_health.marketplace_payout_amount` persistido no sync ML.
// - Objeto `net_proceeds` permanece para breakdown auxiliar; valores de repasse nele são alinhados ao health quando houver payout persistido.
// - `legacy_imported_orders_metrics`: espelho explícito dos totais importados (gross/net/comissão) — agregado, não unitário.
// - Tarifa (R$) + repasse no Raio-x: com `sale_fee_percent` confiável, derivam do mesmo preço-base
//   da UI — com promoção = effective_sale_price_brl; sem = listing_price_brl. Fecha: base − tarifa − frete = repasse.
// - Sem % confiável: fallback em `sale_fee_amount` persistido (+ reconciliação residual por identidade).
// - Frete composição Raio-X: `shipping_cost_*`; frete estimado pré-venda: `estimated_seller_shipping_*` / `shipping_cost_auxiliary_*` (shipping_options/free).
// - Preço / promoção: `listing_price_brl`, `promotion_active`, `promotion_price_brl`, `effective_sale_price_brl`
//   (regra única; não esconder promo só porque suse7_pricing_resolution falhou).
// - Visitas: health.visits (join com marketplace_listing_health).
// ======================================================

import Decimal from "decimal.js";
import { normalizeExternalListingId } from "../mlSalesPersist.js";
import { ATTENTION_REASON_SKU_PENDING_ML } from "../mlItemSkuExtract.js";
import {
  coalesceMercadoLibreItemForMoneyExtract,
  extractWholesalePriceTier,
} from "../mlItemMoneyExtract.js";
import {
  mercadoLivreListingPayloadForMoneyFields,
  mercadoLivrePickListingPriceCandidate,
  mercadoLivreToFiniteGrid,
} from "../mercadoLivreListingMoneyShared.js";
import {
  MERCADO_LIVRE_PROMO_PRICE_TOL,
  logMercadoLivrePromotionDetectMaybe,
  resolvePromotionState,
} from "../mercadoLivrePromotionResolve.js";
import { computeMercadoLivreUnitNetProceeds } from "../netProceeds/mercadoLivreNetProceedsCalculator.js";
import { buildProductReadinessInputFromListing, computeProductReadiness } from "../../../../domain/productReadiness.js";
import { buildMercadoLivrePricingContext } from "./mercadoLivreRaioxPricing.js";

/**
 * @param {string | null | undefined} listingTypeId
 * @returns {{ label: string | null; raw: string | null }}
 */
export function normalizeMercadoLivreListingType(listingTypeId) {
  if (listingTypeId == null || String(listingTypeId).trim() === "") {
    return { label: null, raw: null };
  }
  const raw = String(listingTypeId).trim();
  const id = raw.toLowerCase();
  if (id === "gold_special" || id === "special") return { label: "Clássico", raw };
  if (id === "gold_pro" || id === "gold_premium" || id === "pro") return { label: "Premium", raw };
  if (id === "free") return { label: "Grátis", raw };
  return { label: null, raw };
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function decStr(v) {
  if (v == null || v === "") return null;
  try {
    return new Decimal(String(v)).toFixed(2);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function pctStr(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v));
    return d.toFixed(2).replace(/\.?0+$/, "");
  } catch {
    return null;
  }
}

/**
 * Quando repasse + frete + preço efetivo vêm do mesmo sync ML, a tarifa em R$ deve fechar
 * `venda_efetiva − frete − você_recebe`. Corrige ex.: tarifa bruta (% sobre catálogo) gravada
 * enquanto o payout já é sobre promoção.
 *
 * @param {{
 *   effectiveSaleNum: number | null;
 *   shippingNum: number | null;
 *   payoutNum: number | null;
 *   healthFeeNum: number | null;
 * }} p
 * @returns {number | null} substitui `sale_fee_amount` quando divergência &gt; tolerância; senão null.
 */
function reconcileMlCommissionAmountWithSalePayoutIdentity(p) {
  const { effectiveSaleNum, shippingNum, payoutNum, healthFeeNum } = p;
  if (effectiveSaleNum == null || !Number.isFinite(effectiveSaleNum) || effectiveSaleNum <= 0) return null;
  if (payoutNum == null || !Number.isFinite(payoutNum) || payoutNum < 0) return null;
  const ship =
    shippingNum != null && Number.isFinite(shippingNum) && shippingNum >= 0 ? shippingNum : 0;
  let implied;
  try {
    implied = new Decimal(String(effectiveSaleNum))
      .minus(new Decimal(String(ship)))
      .minus(new Decimal(String(payoutNum)))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toNumber();
  } catch {
    return null;
  }
  if (!Number.isFinite(implied) || implied < 0) return null;
  if (healthFeeNum == null || !Number.isFinite(healthFeeNum) || healthFeeNum <= 0) {
    return implied > 0 ? implied : null;
  }
  const delta = Math.abs(implied - healthFeeNum);
  if (delta <= 0.03) return null;
  return implied > 0 ? implied : null;
}

/** Mesmo teto de sanidade que o sync health (evita % espúrio). */
const MAX_GRID_DERIVED_SALE_FEE_PERCENT = 45;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isTrustedGridSaleFeePercent(v) {
  const n = typeof v === "number" ? v : v != null && v !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return false;
  return n <= MAX_GRID_DERIVED_SALE_FEE_PERCENT;
}

/**
 * Regra Raio-x: comissão = % × base; repasse = base − comissão − frete.
 * Com promoção → base = preço efetivo (linha "Você vende na promoção"). Sem → base = listing (valor de venda).
 *
 * @param {{
 *   promotionActive: boolean;
 *   listingPriceBrl: string | null;
 *   effectiveSalePriceBrl: string | null;
 *   feePercentRaw: unknown;
 *   shippingNum: number | null;
 * }} p
 * @returns {{ feeStr: string; payoutStr: string } | null}
 */
function deriveMlRaioxCommissionAndPayoutFromPercentBase(p) {
  const { promotionActive, listingPriceBrl, effectiveSalePriceBrl, feePercentRaw, shippingNum } = p;
  const pctN = mercadoLivreToFiniteGrid(feePercentRaw);
  if (!isTrustedGridSaleFeePercent(pctN)) return null;

  const listN = mercadoLivreToFiniteGrid(listingPriceBrl);
  const effN = mercadoLivreToFiniteGrid(effectiveSalePriceBrl);

  const base =
    promotionActive && effN != null && effN > 0
      ? effN
      : listN != null && listN > 0
        ? listN
        : effN != null && effN > 0
          ? effN
          : null;
  if (base == null || base <= 0) return null;

  const ship =
    shippingNum != null && Number.isFinite(shippingNum) && shippingNum >= 0 ? shippingNum : 0;

  let feeDec;
  let payoutDec;
  try {
    feeDec = new Decimal(String(base))
      .mul(String(pctN))
      .div(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    payoutDec = new Decimal(String(base))
      .minus(feeDec)
      .minus(new Decimal(String(ship)))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } catch {
    return null;
  }
  if (!payoutDec.isFinite() || payoutDec.lt(0)) return null;

  return { feeStr: feeDec.toFixed(2), payoutStr: payoutDec.toFixed(2) };
}

/**
 * Fonte única: preço de lista (valor de venda), promoção e preço efetivo para motor + UI.
 * Regra: se promoção ativa e preço promocional válido → effective = promo; senão effective = listing.
 *
 * @param {{
 *   listing: Record<string, unknown>;
 *   health: Record<string, unknown> | null | undefined;
 *   pricingResolution: Record<string, unknown> | null;
 *   dbListNum: number | null;
 *   dbPromoNum: number | null;
 *   priceCandidate: unknown;
 *   priceStrFallback: string | null;
 * }} p
 * @param {(v: unknown) => string | null} decStrFn
 */
export function resolveMercadoLivreListingPricingForGrid(p, decStrFn) {
  const { listing, health, pricingResolution, dbListNum, dbPromoNum, priceCandidate, priceStrFallback } = p;
  const toN = mercadoLivreToFiniteGrid;
  const TOL = MERCADO_LIVRE_PROMO_PRICE_TOL;
  const healthSaleNum =
    health != null ? mercadoLivreToFiniteGrid(health.marketplace_sale_price_amount) : null;
  const pr = pricingResolution && typeof pricingResolution === "object" ? pricingResolution : null;
  const resolutionSays = Boolean(pr && (pr.promotion_active === true || pr.has_valid_promotion === true));

  const prListing = pr ? toN(pr.listing_price_brl) : null;
  const prPromo = pr ? toN(pr.promotion_price_brl ?? pr.promotion_price_observed_brl) : null;

  const extId = listing.external_listing_id ?? listing.id ?? null;
  const promoSt = resolvePromotionState({
    listing,
    health: health ?? null,
    pricingResolution,
    saleSnapshot: null,
  });
  logMercadoLivrePromotionDetectMaybe(extId, promoSt);

  const strike = promoSt.coalesced.strike ?? toN(listing.price ?? priceCandidate);
  const orig = promoSt.coalesced.orig ?? toN(listing.original_price);
  const base = promoSt.coalesced.base ?? toN(listing.base_price);

  const dbListing = dbListNum != null && dbListNum > 0 ? dbListNum : null;
  const dbPromoOk = dbPromoNum != null && dbPromoNum > 0 ? dbPromoNum : null;

  let promotion_active = promoSt.promotion_active;

  /** @type {number | null} */
  let listingNum;
  /** @type {number | null} */
  let promoNum;

  if (promotion_active) {
    listingNum =
      (promoSt.listing_catalog_num != null && promoSt.listing_catalog_num > 0
        ? promoSt.listing_catalog_num
        : null) ??
      (prListing != null && prListing > 0 ? prListing : null) ??
      (dbListing != null ? dbListing : null) ??
      (orig != null && orig > 0 ? orig : null) ??
      (base != null && base > 0 ? base : null);
    promoNum =
      (promoSt.promotion_price_num != null && promoSt.promotion_price_num > 0
        ? promoSt.promotion_price_num
        : null) ??
      (prPromo != null && prPromo > 0 ? prPromo : null) ??
      (dbPromoOk != null ? dbPromoOk : null) ??
      (strike != null && strike > 0 ? strike : null);

    const pairInvalid =
      listingNum == null ||
      promoNum == null ||
      promoNum <= 0 ||
      (listingNum != null && promoNum >= listingNum - TOL);
    if (pairInvalid && !resolutionSays) {
      promotion_active = false;
    } else if (pairInvalid && resolutionSays) {
      listingNum = listingNum ?? dbListing ?? orig ?? base ?? promoSt.listing_catalog_num;
      promoNum = promoNum ?? strike ?? dbPromoOk ?? prPromo ?? promoSt.promotion_price_num;
    }
  }

  if (!promotion_active) {
    promoNum = null;
    /**
     * Sem promoção: health (sync ML via GET /items + persist) deve prevalecer sobre colunas/raw_json
     * de `marketplace_listings`, que só atualizam em import/persist completo — evita Raio-x com preço
     * antigo quando o usuário só rodou “Atualizar taxas ML” / backfill.
     */
    listingNum =
      (dbListing != null ? dbListing : null) ??
      (healthSaleNum != null && healthSaleNum > 0 ? healthSaleNum : null) ??
      (prListing != null && prListing > 0 ? prListing : null) ??
      (strike != null && strike > 0 ? strike : null) ??
      (orig != null && orig > 0 ? orig : null) ??
      (base != null && base > 0 ? base : null) ??
      toN(priceCandidate);
  }

  let listing_price_brl =
    listingNum != null && listingNum > 0 ? decStrFn(listingNum) : priceStrFallback;
  let promotion_price_brl =
    promotion_active && promoNum != null && promoNum > 0 ? decStrFn(promoNum) : null;

  if (promotion_active && !promotion_price_brl) {
    promotion_active = false;
    promotion_price_brl = null;
    if (listingNum == null || listingNum <= 0) {
      listingNum =
        (dbListing != null ? dbListing : null) ??
        (strike != null && strike > 0 ? strike : null) ??
        toN(priceCandidate);
    }
  }

  let effectiveNum =
    promotion_active && promoNum != null && promoNum > 0
      ? promoNum
      : listingNum != null && listingNum > 0
        ? listingNum
        : toN(priceCandidate);

  /** Preço efetivo de cálculo: promo quando ativa; senão valor de venda. Sem `prEffective` solto (evita misturar fontes). */
  let effective_sale_price_brl =
    effectiveNum != null && effectiveNum > 0 ? decStrFn(effectiveNum) : listing_price_brl;

  /** Contrato: `listing_price_brl` sempre que houver qualquer evidência numérica de preço no item/health. */
  if (!listing_price_brl || listing_price_brl === "") {
    listing_price_brl =
      effective_sale_price_brl ??
      priceStrFallback ??
      (strike != null && strike > 0 ? decStrFn(strike) : null) ??
      (orig != null && orig > 0 ? decStrFn(orig) : null) ??
      (base != null && base > 0 ? decStrFn(base) : null) ??
      null;
  }

  if (promotion_active && promotion_price_brl) {
    effective_sale_price_brl = promotion_price_brl;
  } else if (!effective_sale_price_brl || effective_sale_price_brl === "") {
    effective_sale_price_brl = listing_price_brl ?? priceStrFallback;
  }

  return {
    promotion_active,
    listing_price_brl,
    promotion_price_brl,
    effective_sale_price_brl,
    /** Contrato oficial: espelha `listing_price_brl` / `promotion_price_brl` (nomes explícitos). */
    listing_sale_price_brl: listing_price_brl,
    promotion_sale_price_brl: promotion_price_brl,
    price_pair_evidence: promoSt.price_pair_evidence ?? null,
  };
}

/** Contrato API v1: normaliza `marketplace_payout_source` para enum fechado. */
function normalizeGridMarketplacePayoutSource(raw) {
  const s = raw != null ? String(raw).trim().toLowerCase() : "";
  if (!s) return "unresolved";
  if (
    s === "ml_official" ||
    s.includes("ml_official") ||
    s === "ml_listing_prices_logistics" ||
    s.includes("ml_listing_prices_logistics") ||
    (s.includes("ml_item") && s.includes("explicit"))
  )
    return "ml_official";
  if (s === "estimated" || s.includes("estimated") || s.includes("sale_minus") || s.includes("components"))
    return "estimated";
  return "unresolved";
}

/** @param {Record<string, unknown>} listing */
function mlPayoutAuditEnabled(listing) {
  if (process.env.ML_PAYOUT_AUDIT_LOG === "1") return true;
  const id = String(listing?.external_listing_id ?? listing?.id ?? "");
  const needle = String(process.env.ML_PAYOUT_AUDIT_EXT_ID ?? "").trim();
  return needle !== "" && id.includes(needle);
}

/**
 * SKU exibido: colunas normalizadas + payload ML (attributes SELLER_SKU, variações).
 * Causa comum de SKU vazio na UI: só em `attributes`/`variations`, sem re-sync após passar a persistir colunas.
 * @param {Record<string, unknown>} listing
 */
function extractSku(listing) {
  const tryStr = (v) => {
    if (v == null || v === "") return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };

  const fromCols = tryStr(listing?.seller_custom_field) ?? tryStr(listing?.seller_sku);
  if (fromCols) return fromCols;

  const raw = listing?.raw_json;
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);

  const fromRoot = tryStr(r.seller_custom_field) ?? tryStr(r.seller_sku);
  if (fromRoot) return fromRoot;

  const attrs = r.attributes;
  if (Array.isArray(attrs)) {
    const sku = attrs.find(
      (x) =>
        x &&
        typeof x === "object" &&
        (x.id === "SELLER_SKU" || String(x.name || "").toUpperCase() === "SKU")
    );
    const vn = sku && typeof sku === "object" ? /** @type {{ value_name?: unknown }} */ (sku).value_name : null;
    if (vn != null && String(vn).trim() !== "") return String(vn).trim();
  }

  const vars = r.variations;
  if (Array.isArray(vars)) {
    for (const v of vars) {
      if (!v || typeof v !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (v);
      const sv = tryStr(o.seller_custom_field) ?? tryStr(o.seller_sku);
      if (sv) return sv;
    }
  }

  return null;
}

/** Garante chaves estáveis em GET /api/ml/listings (valores ausentes = null / false). */
const MERCADO_LIVRE_GRID_DEFAULTS = {
  id: null,
  listing_id: null,
  marketplace: "mercado_livre",
  external_listing_id: null,
  title: null,
  sku: null,
  cover_thumbnail_url: null,
  listing_type_id: null,
  listing_type_label: null,
  listing_type_tooltip: null,
  price_brl: null,
  list_or_original_price_brl: null,
  /** Preço de lista (valor de venda) — regra única com `promotion_*` / `effective_sale_price_brl`. */
  listing_price_brl: null,
  /** Padrão oficial: preço base atual (sempre exibido como “Valor de venda”). */
  listing_sale_price_brl: null,
  /** Padrão oficial: preço promocional atual (só com promoção). */
  promotion_sale_price_brl: null,
  /** `item_prices_array` | `sale_price_snapshot` | `item_coalesced_or_health_fallback` | null */
  listing_grid_price_evidence: null,
  promotion_active: false,
  promotional_price_brl: null,
  effective_sale_price_brl: null,
  sold_quantity: 0,
  /** Total de vendas no anúncio segundo o ML (snapshot); pode divergir de sold_quantity (pedidos importados). */
  sold_quantity_ml_listing: null,
  gross_revenue_brl: null,
  gross_revenue_missing: false,
  net_receive_brl: null,
  marketplace_payout_amount: null,
  marketplace_payout_source: null,
  commission_percent: null,
  commission_amount_brl: null,
  shipping_cost_brl: null,
  shipping_cost_amount: null,
  shipping_cost_amount_brl: null,
  shipping_cost_currency: "BRL",
  shipping_cost_source: null,
  shipping_cost_context: null,
  shipping_cost_label: null,
  /**
   * Simulação ML (shipping_options/free), espelho de `raw_json.suse7_shipping_cost.auxiliary_*`.
   * Não usar como frete Raio-X na UI principal.
   */
  shipping_cost_auxiliary_brl: null,
  shipping_cost_auxiliary_source: null,
  /** Frete estimado do seller (pré-venda); colunas dedicadas no health. */
  estimated_seller_shipping_amount: null,
  estimated_seller_shipping_source: null,
  estimated_seller_shipping_currency: null,
  estimated_seller_shipping_synced_at: null,
  /** Repasse unitário por venda (Decimal no servidor → strings na API). */
  net_proceeds: null,
  /** Custos internos + resultado do Raio-x (backend apenas). */
  pricing_context: null,
  /**
   * Totais agregados de `listing_sales_metrics` (pedidos importados). Não confundir com repasse unitário.
   * @type {Record<string, unknown> | null}
   */
  legacy_imported_orders_metrics: null,
  visits: null,
  visits_absent: true,
  health_listing_quality_score: null,
  health_listing_quality_status: null,
  health_experience_status: null,
  health_shipping_logistic_type: null,
  status: null,
  health_percent: null,
  pictures_count: null,
  variations_count: null,
  permalink: null,
  currency_id: null,
  wholesale_min_quantity: null,
  wholesale_price_brl: null,
  product_catalog_completeness: null,
  financial_analysis_blocked: false,
  needs_attention: false,
  financial_analysis_hint: null,
  product_id: null,
  attention_reason: null,
  sku_pending: false,
  /** Alias semântico de cover_thumbnail_url (mesma URL resolvida no backend). */
  cover_image_url: null,
};

/**
 * @param {{
 *   listing: Record<string, unknown>;
 *   metrics: Record<string, unknown> | null | undefined;
 *   health: Record<string, unknown> | null | undefined;
 *   cover_thumbnail_url: string | null;
 *   sellerTaxPct?: string | number | null;
 * }} input
 */
export function buildMercadoLivreListingGridRow(input) {
  const { listing, metrics, health, cover_thumbnail_url, sellerTaxPct } = input;
  const listingType = normalizeMercadoLivreListingType(
    listing.listing_type_id != null ? String(listing.listing_type_id) : null
  );
  const tooltipType =
    listingType.label != null
      ? `Tipo do anúncio: ${listingType.label}`
      : listingType.raw != null
        ? `Tipo do anúncio (ML): ${listingType.raw}`
        : null;

  const qtyMetrics = metrics?.qty_sold_total != null ? Number(metrics.qty_sold_total) : NaN;
  const qtyListing = listing.sold_quantity != null ? Number(listing.sold_quantity) : 0;
  const soldQty = Number.isFinite(qtyMetrics) ? Math.trunc(qtyMetrics) : Math.trunc(qtyListing) || 0;
  const soldQtyMlPublic =
    listing.sold_quantity != null && Number.isFinite(Number(listing.sold_quantity))
      ? Math.trunc(Number(listing.sold_quantity))
      : null;

  let grossStr = null;
  let grossMissing = false;
  if (metrics && metrics.gross_revenue_total != null && String(metrics.gross_revenue_total).trim() !== "") {
    grossStr = decStr(metrics.gross_revenue_total);
  } else if (soldQty > 0) {
    grossMissing = true;
  } else {
    grossStr = "0.00";
  }

  /** @type {Record<string, unknown> | null} */
  const legacyImported =
    metrics && typeof metrics === "object"
      ? {
          qty_sold_total:
            metrics.qty_sold_total != null && String(metrics.qty_sold_total).trim() !== ""
              ? Math.trunc(Number(metrics.qty_sold_total))
              : null,
          gross_revenue_brl:
            metrics.gross_revenue_total != null && String(metrics.gross_revenue_total).trim() !== ""
              ? decStr(metrics.gross_revenue_total)
              : null,
          net_revenue_total_brl:
            metrics.net_revenue_total != null && String(metrics.net_revenue_total).trim() !== ""
              ? decStr(metrics.net_revenue_total)
              : null,
          commission_amount_total_brl:
            metrics.commission_amount_total != null &&
            String(metrics.commission_amount_total).trim() !== ""
              ? decStr(metrics.commission_amount_total)
              : null,
          shipping_share_total_brl:
            metrics.shipping_share_total != null && String(metrics.shipping_share_total).trim() !== ""
              ? decStr(metrics.shipping_share_total)
              : null,
          orders_count:
            metrics.orders_count != null && String(metrics.orders_count).trim() !== ""
              ? Math.trunc(Number(metrics.orders_count))
              : null,
          last_sale_at: metrics.last_sale_at ?? null,
        }
      : null;

  const moneyShapeBase = coalesceMercadoLibreItemForMoneyExtract(
    mercadoLivreListingPayloadForMoneyFields(listing, health)
  );
  const priceCandidate = mercadoLivrePickListingPriceCandidate(listing);
  const moneyShape = {
    ...moneyShapeBase,
    price:
      moneyShapeBase.price != null && moneyShapeBase.price !== ""
        ? moneyShapeBase.price
        : priceCandidate ?? null,
  };

  let netProceeds;
  try {
    const raw = computeMercadoLivreUnitNetProceeds(listing, health, metrics ?? null);
    netProceeds =
      raw && typeof raw === "object"
        ? raw
        : {
            sale_price: null,
            original_price: null,
            sale_fee_amount: null,
            sale_fee_percent: null,
            shipping_cost_amount: null,
            net_proceeds_amount: null,
            marketplace_payout_amount: null,
            marketplace_payout_amount_brl: null,
            marketplace_payout_source: null,
            marketplace_cost_reduction_amount: null,
            marketplace_cost_reduction_amount_brl: null,
            marketplace_cost_reduction_source: null,
            marketplace_cost_reduction_label: null,
            currency: "BRL",
            is_estimated: false,
            source: "insufficient_data",
            insufficient_reason: "Resposta inválida do calculador de repasse unitário.",
            has_valid_data: false,
          };
  } catch (err) {
    console.error(
      "[ml/grid] computeMercadoLivreUnitNetProceeds",
      listing?.external_listing_id ?? listing?.id,
      err
    );
    netProceeds = {
      sale_price: null,
      original_price: null,
      sale_fee_amount: null,
      sale_fee_percent: null,
      shipping_cost_amount: null,
      net_proceeds_amount: null,
      marketplace_payout_amount: null,
      marketplace_payout_amount_brl: null,
      marketplace_payout_source: null,
      marketplace_cost_reduction_amount: null,
      marketplace_cost_reduction_amount_brl: null,
      marketplace_cost_reduction_source: null,
      marketplace_cost_reduction_label: null,
      currency: "BRL",
      is_estimated: false,
      source: "insufficient_data",
      insufficient_reason: "Erro interno ao calcular repasse unitário; verifique os logs do servidor.",
      has_valid_data: false,
    };
  }

  const persistedPayoutRaw = health?.marketplace_payout_amount;
  const persistedPayoutStr =
    persistedPayoutRaw != null && String(persistedPayoutRaw).trim() !== ""
      ? decStr(persistedPayoutRaw)
      : null;
  if (persistedPayoutStr) {
    netProceeds = {
      ...netProceeds,
      net_proceeds_amount: persistedPayoutStr,
      marketplace_payout_amount: persistedPayoutStr,
      marketplace_payout_amount_brl: persistedPayoutStr,
      marketplace_payout_source: normalizeGridMarketplacePayoutSource(health?.marketplace_payout_source ?? null),
    };
  }

  const priceStr = decStr(priceCandidate ?? moneyShape.price);

  const dbListNum = mercadoLivreToFiniteGrid(health?.list_or_original_price_brl);
  const dbListStr = dbListNum != null && dbListNum > 0 ? decStr(dbListNum) : null;
  const dbPromoNumRaw =
    mercadoLivreToFiniteGrid(health?.promotional_price_brl) ??
    mercadoLivreToFiniteGrid(health?.promotion_price);
  const pricingResolution =
    health?.raw_json && typeof health.raw_json === "object" && health.raw_json.suse7_pricing_resolution
      ? /** @type {Record<string, unknown>} */ (health.raw_json.suse7_pricing_resolution)
      : null;

  const gridPricing = resolveMercadoLivreListingPricingForGrid(
    {
      listing,
      health,
      pricingResolution,
      dbListNum,
      dbPromoNum: dbPromoNumRaw,
      priceCandidate,
      priceStrFallback: priceStr,
    },
    decStr
  );

  const feePctStr =
    health?.sale_fee_percent != null && String(health.sale_fee_percent).trim() !== ""
      ? pctStr(health.sale_fee_percent)
      : null;

  const shipNumUnified =
    mercadoLivreToFiniteGrid(health?.shipping_cost_amount) ??
    mercadoLivreToFiniteGrid(health?.shipping_cost);

  const raioxDerived = deriveMlRaioxCommissionAndPayoutFromPercentBase({
    promotionActive: gridPricing.promotion_active === true,
    listingPriceBrl: gridPricing.listing_price_brl,
    effectiveSalePriceBrl: gridPricing.effective_sale_price_brl,
    feePercentRaw: health?.sale_fee_percent,
    shippingNum: shipNumUnified,
  });

  let feeAmtStr =
    health?.sale_fee_amount != null && String(health.sale_fee_amount).trim() !== ""
      ? decStr(health.sale_fee_amount)
      : null;

  let displayPayoutStr = persistedPayoutStr;
  let gridPayoutSource = normalizeGridMarketplacePayoutSource(health?.marketplace_payout_source ?? null);

  if (raioxDerived) {
    feeAmtStr = raioxDerived.feeStr;
    displayPayoutStr = raioxDerived.payoutStr;
    gridPayoutSource = "estimated";
    netProceeds = {
      ...netProceeds,
      net_proceeds_amount: displayPayoutStr,
      marketplace_payout_amount: displayPayoutStr,
      marketplace_payout_amount_brl: displayPayoutStr,
      sale_fee_amount: raioxDerived.feeStr,
      sale_fee_percent: feePctStr,
    };
  } else {
    const payoutNumForFeeAlign = mercadoLivreToFiniteGrid(
      health?.marketplace_payout_amount ?? health?.marketplace_payout_amount_brl
    );
    const effectiveNumForFeeAlign = mercadoLivreToFiniteGrid(gridPricing.effective_sale_price_brl);
    const feeReconciled = reconcileMlCommissionAmountWithSalePayoutIdentity({
      effectiveSaleNum: effectiveNumForFeeAlign,
      shippingNum: shipNumUnified,
      payoutNum: payoutNumForFeeAlign,
      healthFeeNum: mercadoLivreToFiniteGrid(health?.sale_fee_amount),
    });
    if (feeReconciled != null) feeAmtStr = decStr(feeReconciled);
  }

  const shipFromHealthAmount =
    health?.shipping_cost_amount != null && String(health.shipping_cost_amount).trim() !== ""
      ? decStr(health.shipping_cost_amount)
      : null;
  const shipFromHealthLegacy =
    health?.shipping_cost != null && String(health.shipping_cost).trim() !== ""
      ? decStr(health.shipping_cost)
      : null;
  const shipFromNp =
    netProceeds.shipping_cost_amount != null && String(netProceeds.shipping_cost_amount).trim() !== ""
      ? decStr(netProceeds.shipping_cost_amount)
      : null;
  const officialShippingSourceNorm =
    health?.shipping_cost_source != null && String(health.shipping_cost_source).trim() !== ""
      ? String(health.shipping_cost_source).trim().toLowerCase()
      : null;
  /** Colunas persistidas = oficial; calculadora só se health ainda não tem frete persistido. Sem fallback de net_proceeds quando a fonte oficial está unresolved. */
  const shipStr =
    shipFromHealthAmount ??
    shipFromHealthLegacy ??
    (officialShippingSourceNorm === "unresolved" ? null : shipFromNp);
  const suse7ShipBlob =
    health?.raw_json &&
    typeof health.raw_json === "object" &&
    "suse7_shipping_cost" in /** @type {Record<string, unknown>} */ (health.raw_json)
      ? /** @type {Record<string, unknown>} */ (
          /** @type {Record<string, unknown>} */ (health.raw_json).suse7_shipping_cost
        )
      : null;
  const shipAuxStr =
    suse7ShipBlob &&
    suse7ShipBlob.auxiliary_amount_brl != null &&
    String(suse7ShipBlob.auxiliary_amount_brl).trim() !== ""
      ? decStr(suse7ShipBlob.auxiliary_amount_brl)
      : null;
  const shipAuxSource =
    suse7ShipBlob &&
    suse7ShipBlob.auxiliary_source != null &&
    String(suse7ShipBlob.auxiliary_source).trim() !== ""
      ? String(suse7ShipBlob.auxiliary_source).trim()
      : null;
  const estFromHealth =
    health?.estimated_seller_shipping_amount != null &&
    String(health.estimated_seller_shipping_amount).trim() !== ""
      ? decStr(health.estimated_seller_shipping_amount)
      : null;
  const estSrcFromHealth =
    health?.estimated_seller_shipping_source != null && String(health.estimated_seller_shipping_source).trim() !== ""
      ? String(health.estimated_seller_shipping_source).trim()
      : null;
  const shipAuxStrFinal = estFromHealth ?? shipAuxStr;
  const shipAuxSourceFinal = estSrcFromHealth ?? shipAuxSource;

  const healthForPricing =
    raioxDerived != null && health && typeof health === "object"
      ? {
          ...health,
          marketplace_payout_amount: raioxDerived.payoutStr,
          marketplace_payout_amount_brl: raioxDerived.payoutStr,
        }
      : health;

  const netReceiveStr = displayPayoutStr;

  let visitsStr = null;
  let visitsAbsent = true;
  if (health && Object.prototype.hasOwnProperty.call(health, "visits")) {
    visitsAbsent = false;
    const v = health.visits;
    if (v == null) visitsStr = null;
    else visitsStr = String(Math.trunc(Number(v)));
  }
  const att = listing.attention_reason != null ? String(listing.attention_reason) : null;
  const skuPending = att === ATTENTION_REASON_SKU_PENDING_ML;

  const wholesaleTier = extractWholesalePriceTier(moneyShape);
  const wholesaleMinQty =
    wholesaleTier != null && wholesaleTier.minQuantity > 1 ? wholesaleTier.minQuantity : null;
  const wholesalePriceStr =
    wholesaleTier != null && wholesaleTier.amount > 0 ? decStr(wholesaleTier.amount) : null;

  const readinessForRow =
    listing.product_id != null && String(listing.product_id).trim() !== ""
      ? computeProductReadiness(buildProductReadinessInputFromListing(listing))
      : { is_product_ready: false, missing_fields: [], product_completeness_score: 0 };

  const productCosts =
    listing.product_cost_row && typeof listing.product_cost_row === "object"
      ? /** @type {Record<string, unknown>} */ (listing.product_cost_row)
      : null;

  const pricing_context = buildMercadoLivrePricingContext({
    listing,
    health: healthForPricing,
    netProceeds,
    productCosts,
    sellerTaxPct: sellerTaxPct ?? null,
    effectiveSalePriceBrl: gridPricing.effective_sale_price_brl,
  });

  const lid = String(listing.id);
  const out = {
    ...MERCADO_LIVRE_GRID_DEFAULTS,
    id: lid,
    listing_id: lid,
    marketplace: "mercado_livre",
    external_listing_id: normalizeExternalListingId(listing.external_listing_id),
    title: listing.title != null ? String(listing.title) : null,
    sku: extractSku(listing),
    cover_thumbnail_url: cover_thumbnail_url ?? null,
    cover_image_url: cover_thumbnail_url ?? null,
    listing_type_id: listingType.raw,
    listing_type_label: listingType.label,
    listing_type_tooltip: tooltipType,
    // Legado: espelho de `effective_sale_price_brl` — não usar como fonte principal (protocolo v1).
    price_brl: gridPricing.effective_sale_price_brl ?? priceStr,
    list_or_original_price_brl: gridPricing.listing_price_brl ?? dbListStr ?? null,
    listing_price_brl: gridPricing.listing_price_brl,
    listing_sale_price_brl: gridPricing.listing_sale_price_brl ?? gridPricing.listing_price_brl,
    promotion_sale_price_brl: gridPricing.promotion_sale_price_brl ?? gridPricing.promotion_price_brl,
    listing_grid_price_evidence: gridPricing.price_pair_evidence ?? null,
    promotion_active: gridPricing.promotion_active,
    promotional_price_brl: gridPricing.promotion_price_brl,
    effective_sale_price_brl: gridPricing.effective_sale_price_brl,
    sold_quantity: soldQty,
    sold_quantity_ml_listing: soldQtyMlPublic,
    gross_revenue_brl: grossStr,
    gross_revenue_missing: grossMissing,
    net_receive_brl: netReceiveStr,
    marketplace_payout_amount: displayPayoutStr,
    marketplace_payout_source: gridPayoutSource,
    net_proceeds: netProceeds,
    pricing_context,
    legacy_imported_orders_metrics: legacyImported,
    commission_percent: feePctStr,
    commission_amount_brl: feeAmtStr,
    shipping_cost_brl: shipStr,
    shipping_cost_amount: shipFromHealthAmount ?? shipFromHealthLegacy ?? null,
    shipping_cost_amount_brl: shipStr,
    shipping_cost_currency:
      health?.shipping_cost_currency != null && String(health.shipping_cost_currency).trim() !== ""
        ? String(health.shipping_cost_currency).trim()
        : "BRL",
    shipping_cost_source:
      health?.shipping_cost_source != null && String(health.shipping_cost_source).trim() !== ""
        ? String(health.shipping_cost_source).trim()
        : null,
    shipping_cost_context:
      health?.shipping_cost_context === "free_for_buyer" || health?.shipping_cost_context === "buyer_pays"
        ? health.shipping_cost_context
        : null,
    shipping_cost_label:
      health?.shipping_cost_label != null && String(health.shipping_cost_label).trim() !== ""
        ? String(health.shipping_cost_label).trim()
        : null,
    shipping_cost_auxiliary_brl: shipAuxStrFinal,
    shipping_cost_auxiliary_source: shipAuxSourceFinal,
    estimated_seller_shipping_amount: estFromHealth ?? shipAuxStr,
    estimated_seller_shipping_source: estSrcFromHealth ?? shipAuxSource,
    estimated_seller_shipping_currency:
      health?.estimated_seller_shipping_currency != null &&
      String(health.estimated_seller_shipping_currency).trim() !== ""
        ? String(health.estimated_seller_shipping_currency).trim()
        : null,
    estimated_seller_shipping_synced_at:
      health?.estimated_seller_shipping_synced_at != null
        ? String(health.estimated_seller_shipping_synced_at)
        : null,
    visits: visitsAbsent ? null : visitsStr,
    visits_absent: visitsAbsent,
    health_listing_quality_score: health?.listing_quality_score ?? null,
    health_listing_quality_status: health?.listing_quality_status ?? null,
    health_experience_status: health?.experience_status ?? null,
    health_shipping_logistic_type: health?.shipping_logistic_type ?? null,
    status: listing.status != null ? String(listing.status) : null,
    health_percent:
      listing.health != null && Number.isFinite(Number(listing.health))
        ? String(Math.round(Number(listing.health)))
        : null,
    pictures_count: listing.pictures_count != null ? Number(listing.pictures_count) : null,
    variations_count: listing.variations_count != null ? Number(listing.variations_count) : null,
    permalink: listing.permalink ?? null,
    currency_id: listing.currency_id ?? null,
    wholesale_min_quantity: wholesaleMinQty,
    wholesale_price_brl: wholesalePriceStr,
    product_catalog_completeness:
      listing.product_catalog_completeness != null
        ? String(listing.product_catalog_completeness)
        : null,
    financial_analysis_blocked: Boolean(listing.financial_analysis_blocked),
    needs_attention: Boolean(listing.needs_attention),
    financial_analysis_hint: skuPending
      ? "Este anúncio não tem SKU no Mercado Livre. Informe o SKU no Suse7 para vincular ou criar o produto."
      : listing.financial_analysis_blocked &&
          listing.product_id != null &&
          !readinessForRow.is_product_ready
        ? "Complete nome, SKU e custo do produto para liberar a análise financeira completa."
        : null,
    product_id: listing.product_id != null ? String(listing.product_id) : null,
    attention_reason: att,
    sku_pending: skuPending,
    is_product_ready: readinessForRow.is_product_ready,
    missing_fields: readinessForRow.missing_fields,
    product_completeness_score: readinessForRow.product_completeness_score,
  };

  if (mlPayoutAuditEnabled(listing)) {
    console.info("[ML_PAYOUT_AUDIT][grid_row]", {
      listing_id: String(listing?.external_listing_id ?? listing?.id ?? ""),
      listing_price: out.price_brl ?? null,
      sale_fee_amount: out.commission_amount_brl ?? null,
      shipping_cost_amount: out.shipping_cost_amount_brl ?? null,
      fixed_fee_amount: out.net_proceeds?.fixed_fee_amount ?? null,
      net_receivable_calculated: out.net_proceeds?.net_proceeds_amount ?? null,
      marketplace_payout_amount_brl_persisted: out.net_proceeds?.marketplace_payout_amount_brl ?? null,
      payload_net_receive_brl: out.net_receive_brl ?? null,
      payload_pricing_context: out.pricing_context ?? null,
    });
  }

  return out;
}
