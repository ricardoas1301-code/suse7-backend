#!/usr/bin/env node
/**
 * Unitário — resolveMarketplaceSettlementCreditsFromItemFinancial
 */

import assert from "node:assert/strict";
import { resolveMarketplaceSettlementCreditsFromItemFinancial } from "../src/domain/sales/saleExecutiveSettlementCredits.js";

function testPrefersPositiveAdjustmentsOverRebate() {
  const credits = resolveMarketplaceSettlementCreditsFromItemFinancial({
    positive_adjustments_brl: "1.10",
    marketplace_rebate: { amount_brl: "9.99" },
    formula_debug: { selected_shipping_bonus: { amount: "0.89" } },
  });
  assert.equal(credits.toFixed(2), "1.99");
}

function testRebateFallbackWithoutPositiveAdjustments() {
  const credits = resolveMarketplaceSettlementCreditsFromItemFinancial({
    marketplace_rebate: { amount_brl: "1.10" },
  });
  assert.equal(credits.toFixed(2), "1.10");
}

function testEmptyFinancialReturnsZero() {
  const credits = resolveMarketplaceSettlementCreditsFromItemFinancial(null);
  assert.equal(credits.toFixed(2), "0.00");
}

testPrefersPositiveAdjustmentsOverRebate();
testRebateFallbackWithoutPositiveAdjustments();
testEmptyFinancialReturnsZero();
console.log("[OK] test_sale_executive_settlement_credits_unit");
