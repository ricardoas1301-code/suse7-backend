import Decimal from "decimal.js";
import {
  resolveMercadoLivreFinancialFormula,
  resolveMercadoLivreShippingSellerCost,
} from "../src/domain/sales/mercadoLivreSaleFinancialFormula.js";

const CASES = [
  {
    name: "Carlos",
    gross: 68.62,
    fee: 11.32,
    shipping: 10.35,
    adjustments: 2.12,
    net: 49.07,
    listing_type_id: "gold_pro",
    shipment: { shipping_option: { list_cost: 52.34, cost: 41.99 } },
    discounts: {
      details: [
        {
          type: "discount",
          supplier: { funding_mode: "sale_fee" },
          items: [{ id: "MLB456", quantity: 1, amounts: { total: 2.12, seller: 0 } }],
        },
      ],
    },
  },
  {
    name: "Lucas",
    gross: 148.68,
    fee: 24.54,
    fee_net: 19.02,
    shipping: 47.71,
    adjustments: 5.52,
    net: 81.95,
    listing_type_id: "gold_pro",
    qty: 6,
    unit_price: 24.78,
    sale_fee: 19.02,
    listing_item_id: "MLB123",
    shipment: { shipping_option: { list_cost: 53.7, cost: 5.99 } },
    discounts: {
      details: [
        {
          type: "discount",
          supplier: { funding_mode: "sale_fee" },
          items: [{ id: "MLB123", quantity: 6, amounts: { total: 5.52, seller: 0 } }],
        },
      ],
    },
  },
  {
    name: "Thaís",
    gross: 243.26,
    fee: 32.84,
    shipping: 72.08,
    adjustments: 0,
    net: 138.34,
    listing_type_id: "gold_special",
    shipment: { shipping_option: { list_cost: 100, cost: 27.92 } },
    discounts: null,
  },
  {
    name: "Raquel",
    gross: 129.9,
    fee: 21.43,
    shipping: 57.68,
    adjustments: 0,
    net: 50.79,
    listing_type_id: "gold_pro",
    shipment: { shipping_option: { list_cost: 80, cost: 22.32 } },
    discounts: null,
  },
];

let failed = 0;
for (const c of CASES) {
  const line = {
    total_amount: c.gross,
    quantity: c.qty ?? 1,
    unit_price: c.unit_price ?? c.gross,
    listing_type_id: c.listing_type_id,
    sale_fee: c.sale_fee ?? undefined,
    item: c.listing_item_id ? { id: c.listing_item_id } : undefined,
  };
  const result = resolveMercadoLivreFinancialFormula({
    order: { order_items: [line] },
    line,
    shipmentSnapshot: c.shipment,
    discountsSnapshot: c.discounts,
  });

  const shipOnly = resolveMercadoLivreShippingSellerCost(c.shipment, new Decimal(c.gross));

  const checks = [
    ["gross", result.gross_sale_amount_brl, c.gross.toFixed(2)],
    ["fee_gross", result.marketplace_fee_amount_brl, c.fee.toFixed(2)],
    ...(c.fee_net != null
      ? [["fee_net", result.marketplace_fee_net_amount_brl, c.fee_net.toFixed(2)]]
      : []),
    ["shipping", result.shipping_amount_brl, c.shipping.toFixed(2)],
    [
      "adjustments",
      result.positive_adjustments_brl ?? null,
      c.adjustments ? c.adjustments.toFixed(2) : null,
    ],
    ["net", result.net_received_amount_brl, c.net.toFixed(2)],
    ["snapshot_complete", result.snapshot_complete, true],
    ["snapshot_version", result.snapshot_version, "ml_financial_v2"],
    ["ship_resolver", shipOnly.amount?.toFixed(2), c.shipping.toFixed(2)],
  ];

  console.log(`\n=== ${c.name} ===`);
  for (const [label, got, want] of checks) {
    const ok = String(got) === String(want);
    if (!ok) {
      failed += 1;
      console.log(`FAIL ${label}: got=${got} want=${want}`);
    } else {
      console.log(`OK   ${label}: ${got}`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll cases passed.");
