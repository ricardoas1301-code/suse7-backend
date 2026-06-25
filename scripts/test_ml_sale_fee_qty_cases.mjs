import Decimal from "decimal.js";
import { buildMercadoLivreMarketplaceFeeContract } from "../src/domain/sales/mercadoLivreMarketplaceFee.js";
import { resolveMercadoLivreFinancialFormula } from "../src/domain/sales/mercadoLivreSaleFinancialFormula.js";

let failed = 0;

function assertCase(name, condition, detail) {
  if (!condition) {
    failed += 1;
    console.error("FAIL", name, detail);
  } else {
    console.log("OK", name);
  }
}

const ship8325 = { shipping_option: { list_cost: 83.25, cost: 0 } };
const ship1709 = { shipping_option: { list_cost: 17.09, cost: 0 } };

const orderQty3 = {
  id: "2000016523593692",
  total_amount: 558.6,
  order_items: [
    {
      quantity: 3,
      unit_price: 186.2,
      gross_price: 558.6,
      sale_fee: 26.07,
      listing_type_id: "gold_pro",
    },
  ],
};

const lineQty3 = orderQty3.order_items[0];

const finQty3 = resolveMercadoLivreFinancialFormula({
  order: orderQty3,
  line: lineQty3,
  shipmentSnapshot: ship8325,
  discountsSnapshot: { details: [] },
});

assertCase("qty3 fee gross", finQty3.marketplace_fee?.amount_brl === "78.21", {
  fee: finQty3.marketplace_fee?.amount_brl,
  path: finQty3.marketplace_fee?.raw_amount_source_path,
});
assertCase("qty3 fee path", finQty3.marketplace_fee?.raw_amount_source_path === "line.sale_fee_x_qty", finQty3.marketplace_fee);
assertCase("qty3 no rebate", finQty3.marketplace_rebate == null, finQty3.marketplace_rebate);
assertCase("qty3 net", finQty3.net_received_amount_brl === "397.14", finQty3.net_received_amount_brl);

const orderQty2Promo = {
  id: "2000016521263060",
  total_amount: 105.72,
  order_items: [
    {
      quantity: 2,
      unit_price: 52.86,
      gross_price: 157.8,
      sale_fee: 6.12,
      listing_type_id: "gold_pro",
    },
  ],
};

const lineQty2 = orderQty2Promo.order_items[0];

const finQty2 = resolveMercadoLivreFinancialFormula({
  order: orderQty2Promo,
  line: lineQty2,
  shipmentSnapshot: ship1709,
  discountsSnapshot: {
    details: [
      {
        items: [{ id: "MLB", amounts: { total: 52.08 } }],
        supplier: { funding_mode: "sale_fee" },
      },
    ],
  },
});

assertCase("qty2 promo fee gross", finQty2.marketplace_fee?.amount_brl === "17.44", {
  fee: finQty2.marketplace_fee?.amount_brl,
  path: finQty2.marketplace_fee?.raw_amount_source_path,
});
assertCase("qty2 rebate", finQty2.marketplace_rebate?.amount_brl === "5.20", finQty2.marketplace_rebate);
assertCase("qty2 net", finQty2.net_received_amount_brl === "76.39", finQty2.net_received_amount_brl);

const contractQty3 = buildMercadoLivreMarketplaceFeeContract({
  sale_price_brl: "558.60",
  line: lineQty3,
  order: orderQty3,
  qty: 3,
  unit_price_brl: "186.20",
});

assertCase("contract qty3 skips promo", contractQty3.amount_brl === "78.21", contractQty3);

if (failed > 0) process.exit(1);
console.log("All sale_fee × qty cases passed.");
