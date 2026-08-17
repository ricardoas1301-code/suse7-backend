// Validação offline — extras PI no lucro/margem (case MLB6086959274).
import Decimal from "decimal.js";
import { aplicarExtrasPrecificacaoInteligente } from "../src/domain/pricing/aplicarExtrasPrecificacaoInteligente.js";

const scenarioBase = {
  marketplace: {
    sale_price_brl: "299.90",
    sale_fee_amount_brl: "40.49",
    shipping_cost_amount_brl: "68.65",
    marketplace_payout_amount_brl: "190.76",
  },
  internal_costs: {
    product_cost_brl: "129.00",
    tax_amount_brl: "17.99",
    operational_packaging_total_brl: "1.16",
  },
  result: {
    profit_brl: "42.61",
    margin_pct: "14.21",
    offer_status_label: "Aceitável",
  },
};

const extras = {
  plannedPromoEnabled: true,
  plannedPromoPercent: "1.00",
  affiliatesEnabled: true,
  affiliatePercent: "1.00",
  mlAdsEnabled: true,
  mlAdsPercent: "1.00",
  operationalCostEnabled: true,
  operationalCostPercent: "1.00",
};

const out = aplicarExtrasPrecificacaoInteligente(scenarioBase, extras);
const res = out.result;
const pi = out.pricing_intelligence_extras;

const checks = [
  ["payout inalterado", out.marketplace.marketplace_payout_amount_brl, "190.76"],
  ["promotion_reserve_brl", pi.promotion_reserve_brl, "3.00"],
  ["affiliate_brl", pi.affiliate_brl, "3.00"],
  ["ads_brl", pi.ads_brl, "3.00"],
  ["operational_cost_brl", pi.operational_cost_brl, "3.00"],
  ["profit_brl", res.profit_brl, "30.61"],
  ["margin_pct", res.margin_pct, "10.21"],
];

let ok = true;
for (const [label, got, want] of checks) {
  const pass = String(got) === want;
  console.log(`${pass ? "OK" : "FAIL"} ${label}: got=${got} want=${want}`);
  if (!pass) ok = false;
}

// Conferência manual com Decimal
const profitManual = new Decimal("190.76")
  .minus("129.00")
  .minus("17.99")
  .minus("1.16")
  .minus("12.00")
  .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
console.log("profit manual:", profitManual.toFixed(2));

process.exit(ok ? 0 : 1);
