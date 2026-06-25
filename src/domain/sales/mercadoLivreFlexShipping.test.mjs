import assert from "node:assert/strict";
import test from "node:test";
import {
  isMercadoLivreFlexDeliverySale,
  resolveMercadoLivreFinancialFormula,
  resolveMercadoLivreSaleShippingForFinancial,
  resolveMercadoLivreShippingBonusForFinancial,
} from "./mercadoLivreSaleFinancialFormula.js";

const subsidizedShipment = {
  logistic_type: "drop_off",
  shipping_option: { list_cost: 8.9, cost: 0.89 },
};

const flexShipment = {
  logistic_type: "self_service",
  base_cost: 8.9,
  shipping_option: { list_cost: 8.01, cost: 0 },
};

function flexOrder(gross, fee, bonus = 0.89) {
  return {
    id: "flex-test",
    shipping: { logistic_type: "self_service" },
    order_items: [
      {
        quantity: 1,
        unit_price: gross,
        sale_fee: fee,
        listing_type_id: "gold_pro",
      },
    ],
  };
}

test("isMercadoLivreFlexDeliverySale: self_service e flex", () => {
  assert.equal(isMercadoLivreFlexDeliverySale({ shipmentSnapshot: { logistic_type: "self_service" } }), true);
  assert.equal(isMercadoLivreFlexDeliverySale({ shipmentSnapshot: { logistic_type: "flex" } }), true);
  assert.equal(isMercadoLivreFlexDeliverySale({ shipmentSnapshot: { logistic_type: "drop_off" } }), false);
});

test("resolveMercadoLivreSaleShippingForFinancial: FLEX zera frete subsidizado", () => {
  const resolved = resolveMercadoLivreSaleShippingForFinancial({
    order: { shipping: { logistic_type: "self_service" } },
    line: {},
    shipmentSnapshot: flexShipment,
    grossDec: null,
  });
  assert.equal(resolved.amount, 0);
  assert.equal(resolved.source, "flex_no_shipping_charge");
  assert.equal(resolved.shipDec?.toFixed(2), "0.00");
});

test("resolveMercadoLivreShippingBonusForFinancial: FLEX base_cost - list_cost", () => {
  const resolved = resolveMercadoLivreShippingBonusForFinancial({
    order: { shipping: { logistic_type: "self_service" } },
    shipmentSnapshot: flexShipment,
  });
  assert.equal(resolved.amount, 0.89);
  assert.equal(resolved.source, "shipment_base_cost_minus_list_cost");
});

test("CASE 1 — venda 129,90 comissão 21,43 bônus 0,89 sem envio", () => {
  const order = flexOrder(129.9, 21.43);
  const line = order.order_items[0];
  const fin = resolveMercadoLivreFinancialFormula({
    order,
    line,
    shipmentSnapshot: flexShipment,
    discountsSnapshot: { details: [] },
  });
  assert.equal(fin.shipping_amount_brl, "0.00");
  assert.equal(fin.shipping_bonus_brl, "0.89");
  assert.equal(fin._sources.shipping, "flex_no_shipping_charge");
  assert.equal(fin.marketplace_fee_amount_brl, "21.43");
  assert.equal(fin.gross_sale_amount_brl, "129.90");
  assert.equal(fin.net_received_amount_brl, "109.36");
});

test("CASE 2 — venda 117,00 comissão 21,06 bônus 0,89 sem envio", () => {
  const order = flexOrder(117, 21.06);
  const line = order.order_items[0];
  const fin = resolveMercadoLivreFinancialFormula({
    order,
    line,
    shipmentSnapshot: flexShipment,
    discountsSnapshot: { details: [] },
  });
  assert.equal(fin.shipping_amount_brl, "0.00");
  assert.equal(fin.shipping_bonus_brl, "0.89");
  assert.equal(fin.net_received_amount_brl, "96.83");
});

test("CASE 3 — mesmo caso 129,90 idempotente", () => {
  const order = flexOrder(129.9, 21.43);
  const line = order.order_items[0];
  const fin = resolveMercadoLivreFinancialFormula({
    order,
    line,
    shipmentSnapshot: flexShipment,
    discountsSnapshot: { details: [] },
  });
  assert.equal(fin.shipping_amount_brl, "0.00");
  assert.equal(fin.net_received_amount_brl, "109.36");
  assert.notEqual(fin.net_received_amount_brl, "100.46");
});

test("não-FLEX continua descontando frete subsidizado", () => {
  const order = {
    id: "std",
    shipping: { logistic_type: "drop_off" },
    order_items: [{ quantity: 1, unit_price: 129.9, sale_fee: 21.43, listing_type_id: "gold_pro" }],
  };
  const fin = resolveMercadoLivreFinancialFormula({
    order,
    line: order.order_items[0],
    shipmentSnapshot: subsidizedShipment,
    discountsSnapshot: { details: [] },
  });
  assert.equal(fin.shipping_amount_brl, "8.01");
});
