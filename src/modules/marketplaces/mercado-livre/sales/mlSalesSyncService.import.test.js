/**
 * Regressão: import ESM de mlSalesSyncService (typo enrichMercadoLibre quebrava o cron DEV).
 * node --test src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.import.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("mlSalesSyncService import chain", () => {
  it("carrega o módulo e exporta applyMlOrderDetailToMarketplaceSales", async () => {
    const mod = await import("./mlSalesSyncService.js");
    assert.equal(typeof mod.applyMlOrderDetailToMarketplaceSales, "function");
    assert.equal(typeof mod.enrichMlOrderBuyerThumbnailIfNeeded, "function");
  });
});
