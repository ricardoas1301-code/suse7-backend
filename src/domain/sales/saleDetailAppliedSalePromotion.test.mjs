/**
 * Teste offline do contrato applied_sale_promotion (pedido 266,91 / 299,90).
 * node --test src/domain/sales/saleDetailAppliedSalePromotion.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSaleAppliedPromotion, buildSaleDetailMarketplaceRevenue } from "./saleDetailMarketplaceRevenue.js";

const ORDER_EXT = "2000016539534842";
const LISTING = "MLB6086959274";

function fixtureItemAndOrder() {
  const orderLine = {
    id: "OI-123",
    quantity: 1,
    unit_price: 266.91,
    full_unit_price: 299.9,
    base_unit_price: 299.9,
    gross_price: 299.9,
    sale_fee: 31.2,
    item: { id: LISTING, title: "Produto teste" },
  };

  const order = {
    external_order_id: ORDER_EXT,
    raw_json: {
      id: Number(ORDER_EXT),
      order_items: [orderLine],
      _s7_financial: {
        discounts_snapshot: {
          details: [
            {
              type: "discount",
              supplier: { funding_mode: "sale_fee", offer_id: `${LISTING}-promo` },
              items: [
                {
                  id: LISTING,
                  quantity: 1,
                  amounts: { total: 33.01, seller: 33.01 },
                },
              ],
            },
          ],
        },
      },
    },
  };

  const item = {
    id: "test-item-uuid",
    marketplace: "mercado_livre",
    external_order_id: ORDER_EXT,
    external_order_item_id: "OI-123",
    external_listing_id: LISTING,
    quantity: 1,
    unit_price: 266.91,
    gross_amount: 266.91,
    raw_json: { ...orderLine, sale_fee: 31.2 },
  };

  return { item, order };
}

test("resolveSaleAppliedPromotion — gross/base 299,90 vs venda 266,91", () => {
  const { item, order } = fixtureItemAndOrder();
  const promo = resolveSaleAppliedPromotion(item, order);

  assert.ok(promo, "deve retornar promo");
  assert.equal(promo.has_applied_promotion, true);
  assert.equal(promo.original_product_price_brl, "299.90");
  assert.ok(Number(promo.promotion_discount_percent) >= 10);
  assert.ok(promo.promotion_name);
});

test("buildSaleDetailMarketplaceRevenue expõe applied_sale_promotion no contrato", () => {
  const { item, order } = fixtureItemAndOrder();
  const revenue = buildSaleDetailMarketplaceRevenue(item, order);

  assert.ok(revenue.applied_sale_promotion);
  assert.ok(revenue.marketplace_revenue?.applied_sale_promotion);
  assert.equal(revenue.gross_amount, "266.91");
});
