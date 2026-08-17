#!/usr/bin/env node
import Decimal from "decimal.js";
import { computeSaleDetailRealResult } from "../src/domain/sales/saleDetailInternalCosts.js";

const net = new Decimal("109.68");
const internal = {
  product_cost_brl: "66.14",
  internal_tax_brl: "13.82",
  operation_packaging_cost_brl: "1.16",
  confidence: "persisted",
};
const contingency = new Decimal("12.75").plus("3.82"); // exemplo 5% + 1.5% de 255

const { profitDec } = computeSaleDetailRealResult({
  netReceivedDec: net,
  internalCosts: internal,
  contingencyDec: contingency,
});

const expected = net.minus(contingency).minus("66.14").minus("13.82").minus("1.16");
console.log("profit", profitDec?.toFixed(2), "expected", expected.toFixed(2));
if (profitDec?.toFixed(2) !== expected.toFixed(2)) process.exit(1);
console.log("contingency profit formula OK");
