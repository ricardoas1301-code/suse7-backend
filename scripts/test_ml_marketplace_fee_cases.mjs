import Decimal from "decimal.js";
import {
  buildMercadoLivreMarketplaceFeeContract,
  calculateEffectiveMarketplaceFeePercentage,
  calculateMarketplaceFeeAmount,
} from "../src/domain/sales/mercadoLivreMarketplaceFee.js";

/** Cenários com tarifa real (amount) — percentual derivado ou explícito, nunca só listing type. */
const REAL_FEE_CASES = [
  { name: "Edson", gross: "295.45", fee: "39.89", label: "Premium", percent: "13.5", listing_type_id: "gold_pro" },
  { name: "Erika", gross: "400.50", fee: "54.07", label: "Premium", percent: "13.5", listing_type_id: "gold_pro" },
  { name: "Bruna", gross: "39.81", fee: "6.57", label: "Premium", percent: "16.5", listing_type_id: "gold_pro" },
  { name: "Victor", gross: "27.00", fee: "3.10", label: "Clássico", percent: "11.5", listing_type_id: "gold_special" },
  { name: "Residencial", gross: "73.00", fee: "12.04", label: "Premium", percent: "16.5", listing_type_id: "gold_pro" },
];

let failed = 0;

for (const c of REAL_FEE_CASES) {
  const pctFromReal = calculateEffectiveMarketplaceFeePercentage({
    fee_amount_brl: c.fee,
    sale_price_brl: c.gross,
  });
  const okPctCalc = pctFromReal === c.percent || pctFromReal === new Decimal(c.percent).toFixed(2);

  const line = {
    sale_fee: Number(c.fee),
    unit_price: Number(c.gross),
    gross_price: Number(c.gross),
    listing_type_id: c.listing_type_id,
  };
  if (c.name === "Bruna") {
    line.sale_fee = 5.34;
    line.gross_price = 45.6;
    line.unit_price = 39.81;
  }
  const contract = buildMercadoLivreMarketplaceFeeContract({
    sale_price_brl: c.gross,
    listing_type_id: c.listing_type_id,
    line,
    qty: 1,
  });

  const okAmount = contract.amount_brl === c.fee;
  const okLabel = contract.listing_type_label === c.label;
  const okPct =
    contract.percentage === c.percent ||
    contract.percentage === new Decimal(c.percent).toFixed(2);
  const okSource =
    contract.percentage_source === "calculated_from_real_fee" ||
    contract.percentage_source === "explicit_from_marketplace";
  const notFallback = contract.percentage_source !== "fallback_listing_type";

  if (!okAmount || !okLabel || !okPct || !okPctCalc || !okSource || !notFallback) {
    failed += 1;
    console.error("FAIL", c.name, {
      pctFromReal,
      contract,
      okAmount,
      okLabel,
      okPct,
      okPctCalc,
      okSource,
      notFallback,
    });
  } else {
    console.log(
      "OK",
      c.name,
      contract.listing_type_label,
      contract.percentage,
      contract.amount_brl,
      contract.percentage_source,
    );
  }
}

const fallback = buildMercadoLivreMarketplaceFeeContract({
  sale_price_brl: "100.00",
  listing_type_id: "gold_pro",
  line: { listing_type_id: "gold_pro" },
});
if (fallback.percentage_source !== "fallback_listing_type" || fallback.is_estimated !== true) {
  failed += 1;
  console.error("FAIL fallback should be estimated listing type", fallback);
} else {
  console.log("OK fallback_listing_type when no real fee");
}

const wrongDefault = calculateMarketplaceFeeAmount({
  sale_price_brl: "295.45",
  fee_percentage: "16.5",
});
if (wrongDefault === "48.75") {
  console.log("NOTE: 16.5% of 295.45 would be", wrongDefault, "— must not use as primary for Edson");
}

if (failed > 0) process.exit(1);
console.log("All marketplace fee historical cases passed.");
