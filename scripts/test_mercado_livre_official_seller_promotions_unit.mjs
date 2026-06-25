// Unit smoke — normalização oficial GET /seller-promotions/items
import assert from "node:assert/strict";
import {
  buildOfficialSellerPromotionIdentityKey,
  classifyOfficialMlSellerPromotionStatus,
  normalizeOfficialSellerPromotionsFromApi,
  resolveOfficialPromotionSellerDiscount,
  resolveOfficialSellerPromotionFinancials,
  resolveOfficialSellerPromotionPrices,
} from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";

const CATALOG_MLB6086959274 = "299.90";

const rows = [
  {
    id: "P-MLB1",
    type: "PRICE_DISCOUNT",
    ref_id: "OFFER-1",
    status: "started",
    price: 80,
    original_price: 100,
  },
  {
    id: "P-MLB2",
    type: "SELLER_CAMPAIGN",
    status: "pending",
    price: 0,
    original_price: 100,
    suggested_discounted_price: 85,
    start_date: "2026-06-01T00:00:00",
    finish_date: "2026-06-30T00:00:00",
  },
  {
    id: "P-MLB3",
    type: "PRICE_MATCHING",
    status: "candidate",
    price: 0,
    original_price: 100,
    min_discounted_price: 70,
  },
  {
    id: "P-MLB1",
    type: "PRICE_DISCOUNT",
    ref_id: "OFFER-1",
    status: "started",
    price: 80,
    original_price: 100,
  },
];

assert.equal(buildOfficialSellerPromotionIdentityKey(rows[0]), "P-MLB1|PRICE_DISCOUNT|OFFER-1");

const started = classifyOfficialMlSellerPromotionStatus("started");
assert.equal(started.promotion_active, true);
assert.equal(started.normalized_status, "active");

const pending = classifyOfficialMlSellerPromotionStatus("pending");
assert.equal(pending.promotion_active, false);
assert.equal(pending.normalized_status, "scheduled");

const candidate = classifyOfficialMlSellerPromotionStatus("candidate");
assert.equal(candidate.promotion_active, false);
assert.equal(candidate.normalized_status, "candidate");

const priceZero = resolveOfficialSellerPromotionPrices(rows[2]);
assert.equal(priceZero.price_applied, false);
assert.equal(priceZero.final_price_brl, "70.00");

const normalized = normalizeOfficialSellerPromotionsFromApi(rows, { source: "live" });
assert.equal(normalized.promotions.length, 3);
assert.equal(normalized.dropped_as_duplicate, 1);
assert.equal(normalized.status_counts.started, 1);
assert.equal(normalized.status_counts.pending, 1);
assert.equal(normalized.status_counts.candidate, 1);

const invernoCasa = resolveOfficialSellerPromotionFinancials(
  {
    id: "P-INVERNO",
    type: "SELLER_CAMPAIGN",
    name: "Ofertas Inverno Casa",
    status: "candidate",
    price: 258.9,
    original_price: 258.9,
    seller_percentage: 11,
    meli_percentage: 2.7,
    fee_discount_amount: 7.54,
  },
  "258.90",
  CATALOG_MLB6086959274
);
assert.equal(invernoCasa.seller_discount_amount_brl, "41.00");
assert.equal(invernoCasa.seller_discount_percent, "14.00");
assert.equal(invernoCasa.seller_discount_percent_display, "14");
assert.equal(invernoCasa.promotion_subsidy_amount_brl, "7.54");

const aumenteVendas = resolveOfficialSellerPromotionFinancials(
  {
    id: "P-MLB-AUMENTE-VENDAS",
    type: "PRICE_DISCOUNT",
    status: "started",
    price: 236,
    original_price: 236,
    seller_percentage: 8,
    meli_percentage: 0.8,
    discount_meli_boost_amount: 1.85,
  },
  "236.00",
  CATALOG_MLB6086959274
);
assert.equal(aumenteVendas.seller_discount_amount_brl, "63.90");
assert.equal(aumenteVendas.seller_discount_percent, "21.00");
assert.equal(aumenteVendas.seller_discount_percent_display, "21");
assert.equal(aumenteVendas.promotion_subsidy_amount_brl, "1.85");

const casaRenovada = resolveOfficialPromotionSellerDiscount({
  catalogOriginalPriceBrl: CATALOG_MLB6086959274,
  promotionPriceBrl: "236.00",
  rawRow: { discount_amount: 63.9, discount_percentage: 21 },
  promotionName: "Promoção Casa Renovada",
});
assert.equal(casaRenovada.seller_discount_amount_brl, "63.90");
assert.equal(casaRenovada.seller_discount_percent_display, "21");

const invernoPresentation = (
  await import("../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js")
).resolveOfficialPromotionPresentationFinancials({
  grossFeeBrl: "34.95",
  salePriceBrl: "258.90",
  shippingCostBrl: "68.65",
  fin: invernoCasa,
  rawRow: { amount_to_receive: 162.84 },
});
assert.equal(invernoPresentation.expected_payout_brl, "162.84");
assert.equal(invernoPresentation.fee_discount_brl, "7.54");

console.log("OK mercado_livre_official_seller_promotions_unit");
