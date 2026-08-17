/**
 * Reconciliação gross vs header.
 * node --test src/handlers/ml/_helpers/salesOrderItemsCanonicalPersist.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileSalesOrderItemsGrossVsHeader } from "./salesOrderItemsCanonicalPersist.js";

describe("reconcileSalesOrderItemsGrossVsHeader", () => {
  it("ok quando soma bate header", () => {
    const r = reconcileSalesOrderItemsGrossVsHeader("266.05", [{ gross_amount: "266.05" }]);
    assert.equal(r.ok, true);
    assert.equal(r.delta_brl, "0.00");
  });

  it("falha quando duplicata infla gross", () => {
    const r = reconcileSalesOrderItemsGrossVsHeader("266.05", [
      { gross_amount: "266.05" },
      { gross_amount: "266.05" },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.sum_gross_brl, "532.10");
    assert.equal(r.header_total_brl, "266.05");
    assert.equal(r.delta_brl, "266.05");
  });
});
