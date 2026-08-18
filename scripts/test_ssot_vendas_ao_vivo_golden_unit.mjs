#!/usr/bin/env node
/**
 * Golden dataset — SSOT Vendas ao Vivo (.02) — fixture congelada (46 orders).
 * Não depende da cardinalidade atual da janela temporal (late arrivals).
 */

import dotenv from "dotenv";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFrozenGoldenExecutiveSummary,
  loadSsotVendasAoVivoGoldenFixture,
} from "./lib/ssotVendasAoVivoGoldenFixture.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });

/** KPIs estáveis de marketplace/repasse — não dependem de snapshot interno corrompido. */
/** @type {Record<string, string>} */
const STABLE_GOLDEN = {
  orders_count: "46",
  gross_sales_brl: "4710.73",
  average_ticket_brl: "102.41",
  highest_order_gross_brl: "266.05",
  net_received_brl: "3009.54",
  you_receive_brl: "3009.54",
  marketplace_fee_brl: "727.92",
  shipping_cost_brl: "986.86",
  marketplace_settlement_credits_brl: "13.59",
};

function money(raw) {
  return new Decimal(String(raw).replace(",", ".")).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function assertMoney(actual, expected, label) {
  assert.equal(money(actual), money(expected), `${label}: esperado ${expected}, recebido ${actual}`);
}

function sumNominalComponents(summary) {
  const keys = [
    "product_cost_only_brl",
    "marketplace_fee_brl",
    "shipping_cost_brl",
    "tax_cost_brl",
    "operation_packaging_cost_brl",
    "ads_cost_brl",
    "operational_costs_brl",
  ];
  return keys.reduce(
    (acc, key) => acc.plus(money(summary[key] ?? "0")),
    new Decimal(0),
  );
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SKIP: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(0);
  }

  const fixture = loadSsotVendasAoVivoGoldenFixture();
  assert.equal(fixture.external_order_ids.length, 46, "fixture deve conter 46 orders");

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const payload = await buildFrozenGoldenExecutiveSummary(sb, fixture);
  const summary = payload.summary ?? {};

  for (const [field, expected] of Object.entries(STABLE_GOLDEN)) {
    assertMoney(summary[field], expected, field);
  }

  const grossDec = money(summary.gross_sales_brl);
  const profitDec = money(summary.contribution_profit_brl);
  const nominalDec = money(summary.nominal_costs_brl);
  const creditsDec = money(summary.marketplace_settlement_credits_brl);
  const totalDec = money(summary.total_costs_brl);
  const marginDec = money(summary.contribution_margin_percent);

  assert.equal(
    new Decimal(grossDec).minus(totalDec).toFixed(2),
    profitDec,
    "invariante gross - total_costs = lucro",
  );
  assert.equal(
    new Decimal(nominalDec).minus(creditsDec).toFixed(2),
    totalDec,
    "invariante nominal - credits = total_costs",
  );
  assert.equal(
    sumNominalComponents(summary).toFixed(2),
    nominalDec,
    "soma 7 componentes = nominal_costs_brl",
  );
  assert.equal(
    new Decimal(profitDec).div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    marginDec,
    "margem = lucro / faturamento",
  );

  const top3 = (payload.rankings?.products ?? []).slice(0, 3);
  assert.equal(top3.length, 3, "top3 products");
  assert.equal(top3[0]?.sku, "2012");
  assert.equal(String(top3[0]?.quantity_sold), "11");
  assertMoney(top3[0]?.gross_sales_brl, "374.77", "top1 gross");
  assert.equal(top3[1]?.sku, "2048");
  assert.equal(String(top3[1]?.quantity_sold), "10");
  assertMoney(top3[1]?.gross_sales_brl, "1281.60", "top2 gross SKU 2048 produto");
  assert.equal(top3[2]?.sku, "2057");

  const distSum = (payload.distribution?.by_account ?? []).reduce(
    (acc, row) => acc + Number(row.orders_count ?? 0),
    0,
  );
  assert.equal(distSum, 46, "distribuição pedidos");

  console.log("[OK] test_ssot_vendas_ao_vivo_golden_unit", {
    fixture_version: fixture.fixture_version,
    frozen_orders: fixture.external_order_ids.length,
    nominal_costs_brl: nominalDec,
    total_costs_brl: totalDec,
    contribution_profit_brl: profitDec,
    contribution_margin_percent: marginDec,
    delta: "0.00",
  });
}

main().catch((err) => {
  console.error("[FAIL] test_ssot_vendas_ao_vivo_golden_unit", err.message);
  process.exit(1);
});
