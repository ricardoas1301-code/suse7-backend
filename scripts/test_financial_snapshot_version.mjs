import { ML_FINANCIAL_SNAPSHOT_VERSION } from "../src/domain/sales/mercadoLivreSaleRevenueRules.js";
import { validateFinancialSnapshot } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

const legacyLucas = {
  snapshot_complete: true,
  gross_sale_amount_brl: "148.68",
  marketplace_fee_amount_brl: "19.02",
  shipping_amount_brl: "47.71",
  net_received_amount_brl: "81.95",
};

const v2Lucas = {
  ...legacyLucas,
  snapshot_version: ML_FINANCIAL_SNAPSHOT_VERSION,
  marketplace_fee_amount_brl: "24.54",
  marketplace_fee_net_amount_brl: "19.02",
  positive_adjustments_brl: "5.52",
};

const legacyValidation = validateFinancialSnapshot(legacyLucas);
const v2Validation = validateFinancialSnapshot(v2Lucas);

console.log("legacy", legacyValidation);
console.log("v2", v2Validation);

if (!legacyValidation.should_reenrich || legacyValidation.reason !== "snapshot_version_missing") {
  console.error("FAIL: legacy snapshot must require re-enrich");
  process.exit(1);
}

if (v2Validation.should_reenrich || !v2Validation.snapshot_complete) {
  console.error("FAIL: v2 snapshot must be accepted");
  process.exit(1);
}

console.log("OK snapshot version validation");
