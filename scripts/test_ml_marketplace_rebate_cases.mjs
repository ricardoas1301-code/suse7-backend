import Decimal from "decimal.js";
import { resolveMercadoLivreMarketplaceRebate } from "../src/domain/sales/mercadoLivreMarketplaceRebate.js";
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

const marcioDiscounts = {
  details: [
    { type: "discount", items: [{ id: "MLB6086562408", amounts: { total: 22.28, seller: 22.28 } }], supplier: { funding_mode: "seller" } },
    { type: "discount", items: [{ id: "MLB6086562408", amounts: { total: 1.39 } }] },
    { type: "discount", items: [{ id: "MLB6086562408", amounts: { total: 5 } }] },
  ],
};

const marcioFin = resolveMercadoLivreFinancialFormula({
  order: { id: "2000016503467162", order_items: [{ sale_fee: 37.48, unit_price: 277.62, gross_price: 299.9, listing_type_id: "gold_pro" }] },
  line: { sale_fee: 37.48, unit_price: 277.62, gross_price: 299.9, listing_type_id: "gold_pro", total_amount: 277.62 },
  shipmentSnapshot: { shipping_option: { list_cost: 70.25, cost: 0 } },
  discountsSnapshot: marcioDiscounts,
});

assertCase("Marcio no rebate", marcioFin.marketplace_rebate == null, marcioFin.marketplace_rebate);
assertCase("Marcio net", marcioFin.net_received_amount_brl === "169.89", marcioFin.net_received_amount_brl);

const edsonFin = resolveMercadoLivreFinancialFormula({
  order: { id: "2000016508408082", order_items: [{ sale_fee: 22.17, unit_price: 295.45, gross_price: 339.48, listing_type_id: "gold_pro" }] },
  line: { sale_fee: 22.17, unit_price: 295.45, gross_price: 339.48, listing_type_id: "gold_pro", total_amount: 295.45 },
  shipmentSnapshot: { shipping_option: { list_cost: 74.03, cost: 0 } },
  discountsSnapshot: {
    details: [
      {
        items: [{ id: "MLB4222135961", amounts: { total: 44.03 } }],
        supplier: { funding_mode: "sale_fee" },
      },
    ],
  },
});

assertCase("Edson rebate amount", edsonFin.marketplace_rebate?.amount_brl === "17.72", edsonFin.marketplace_rebate);
assertCase("Edson rebate explicit", edsonFin.marketplace_rebate?.confidence === "explicit", edsonFin.marketplace_rebate);
assertCase("Edson net", edsonFin.net_received_amount_brl === "199.25", edsonFin.net_received_amount_brl);

const directMarcio = resolveMercadoLivreMarketplaceRebate({
  feeGrossDec: new Decimal("37.48"),
  line: { sale_fee: 37.48 },
});
assertCase("Marcio direct reject", directMarcio.marketplace_rebate == null, directMarcio.reject_reason);

if (failed > 0) process.exit(1);
console.log("All marketplace rebate cases passed.");
