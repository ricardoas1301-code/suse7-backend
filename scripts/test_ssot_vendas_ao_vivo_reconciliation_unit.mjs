#!/usr/bin/env node
/**
 * Gate matemático — reconciliação golden Vendas ao Vivo (.02) — fixture congelada.
 */

import assert from "node:assert/strict";
import path from "node:path";
import dotenv from "dotenv";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import {
  buildFrozenGoldenExecutiveSummary,
  loadSsotVendasAoVivoGoldenFixture,
} from "./lib/ssotVendasAoVivoGoldenFixture.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });

function money(raw) {
  return new Decimal(String(raw).replace(",", ".")).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SKIP: env Supabase ausente");
    process.exit(0);
  }

  const fixture = loadSsotVendasAoVivoGoldenFixture();
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const payload = await buildFrozenGoldenExecutiveSummary(sb, fixture);
  const s = payload.summary;

  const gross = money(s.gross_sales_brl);
  const profit = money(s.contribution_profit_brl);
  const nominal = money(s.nominal_costs_brl);
  const credits = money(s.marketplace_settlement_credits_brl);
  const totalCosts = money(s.total_costs_brl);

  assert.equal(nominal.minus(credits).toFixed(2), totalCosts.toFixed(2), "nominal − credits = total");
  assert.equal(gross.minus(totalCosts).toFixed(2), profit.toFixed(2), "gross − total = profit");

  assert.equal(gross.toFixed(2), "4710.73");
  assert.equal(String(s.orders_count), "46");
  assert.equal(credits.toFixed(2), "13.59");
  assert.equal(money(s.net_received_brl).toFixed(2), "3009.54");

  console.log("[OK] test_ssot_vendas_ao_vivo_reconciliation_unit", {
    fixture_version: fixture.fixture_version,
    frozen_orders: fixture.external_order_ids.length,
    nominal_costs_brl: nominal.toFixed(2),
    total_costs_brl: totalCosts.toFixed(2),
    contribution_profit_brl: profit.toFixed(2),
    delta: "0.00",
  });
}

main().catch((err) => {
  console.error("[FAIL] test_ssot_vendas_ao_vivo_reconciliation_unit", err.message);
  process.exit(1);
});
