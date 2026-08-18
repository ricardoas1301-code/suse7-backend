#!/usr/bin/env node
/**
 * Ciclo sem vendas/créditos — créditos zero e total = nominal.
 */

import assert from "node:assert/strict";
import path from "node:path";
import dotenv from "dotenv";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { buildSaleExecutiveSummary } from "../src/domain/sales/buildSaleExecutiveSummary.js";
import { resolveExecutiveSummaryPeriod } from "../src/domain/sales/saleExecutivePeriod.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });

const TENANT = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const START = "2026-08-10T21:00:00.000Z";

function money(raw) {
  if (raw == null) return null;
  return new Decimal(String(raw).replace(",", ".")).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SKIP: env Supabase ausente");
    process.exit(0);
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const periodResult = resolveExecutiveSummaryPeriod({
    start_datetime: START,
    end_datetime: new Date().toISOString(),
    period_preset: "operational_cycle",
  });
  assert.equal(periodResult.ok, true);

  const payload = await buildSaleExecutiveSummary(sb, TENANT, {
    period: periodResult.period,
    marketplace: "mercado_livre",
  });
  const s = payload.summary ?? {};

  assert.equal(Number(s.orders_count ?? 0), 0);
  assert.equal(money(s.gross_sales_brl)?.toFixed(2) ?? "0.00", "0.00");
  assert.equal(money(s.marketplace_settlement_credits_brl)?.toFixed(2) ?? "0.00", "0.00");
  assert.equal(money(s.nominal_costs_brl), null);
  assert.equal(money(s.total_costs_brl), null);

  console.log("[OK] test_ssot_vendas_ao_vivo_zero_credits_unit");
}

main().catch((err) => {
  console.error("[FAIL] test_ssot_vendas_ao_vivo_zero_credits_unit", err.message);
  process.exit(1);
});
