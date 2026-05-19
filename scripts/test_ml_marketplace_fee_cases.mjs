import Decimal from "decimal.js";
import {
  buildMercadoLivreMarketplaceFeeContract,
  calculateMarketplaceFeeAmount,
  normalizeMercadoLivreListingType,
} from "../src/domain/sales/mercadoLivreMarketplaceFee.js";

const CASES = [
  { gross: "39.81", listing_type_id: "gold_pro", label: "Premium", percent: "16.5", fee: "6.57" },
  { gross: "27.00", listing_type_id: "gold_special", label: "Clássico", percent: "11.5", fee: "3.10" },
  { gross: "73.00", listing_type_id: "gold_pro", label: "Premium", percent: "16.5", fee: "12.04" },
];

let failed = 0;

for (const c of CASES) {
  const norm = normalizeMercadoLivreListingType(c.listing_type_id);
  const amount = calculateMarketplaceFeeAmount({
    sale_price_brl: c.gross,
    fee_percentage: c.percent,
  });
  const contract = buildMercadoLivreMarketplaceFeeContract({
    sale_price_brl: c.gross,
    listing_type_id: c.listing_type_id,
  });

  const okAmount = amount === c.fee;
  const okPct = contract.percentage === c.percent || contract.percentage === new Decimal(c.percent).toFixed(2);
  const okContractAmt = contract.amount_brl === c.fee;
  const okLabel = contract.listing_type_label === c.label;

  if (!okAmount || !okPct || !okContractAmt || !okLabel) {
    failed += 1;
    console.error("FAIL", c, {
      amount,
      contract,
      norm,
      okAmount,
      okPct,
      okContractAmt,
      okLabel,
    });
  } else {
    console.log("OK", c.gross, contract.listing_type_label, contract.percentage, contract.amount_brl);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log("All marketplace fee cases passed.");
