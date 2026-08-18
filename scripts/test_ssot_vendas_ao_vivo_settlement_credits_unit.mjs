#!/usr/bin/env node
/**
 * Golden — agregação de créditos ML (9 orders, sem duplicar).
 */

import assert from "node:assert/strict";
import path from "node:path";
import dotenv from "dotenv";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { buildSaleExecutiveSummary } from "../src/domain/sales/buildSaleExecutiveSummary.js";
import { resolveExecutiveSummaryPeriod } from "../src/domain/sales/saleExecutivePeriod.js";
import { isExecutiveSummaryEligibleOrderRow } from "../src/domain/sales/saleExecutiveOrderValidity.js";
import { orderMatchesExecutivePeriod } from "../src/domain/sales/saleExecutivePeriod.js";
import { resolveMarketplaceSettlementCreditsFromItemFinancial } from "../src/domain/sales/saleExecutiveSettlementCredits.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });

const TENANT = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const START = "2026-08-07T21:00:00.000Z";
const END = "2026-08-10T21:00:00.000Z";

function money(raw) {
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
    end_datetime: END,
    period_preset: "operational_cycle",
  });

  const payload = await buildSaleExecutiveSummary(sb, TENANT, {
    period: periodResult.period,
    marketplace: "mercado_livre",
  });
  const summary = payload.summary ?? {};

  const { data: orders } = await sb
    .from("sales_orders")
    .select("id, order_status, order_substatus, date_created_marketplace")
    .eq("user_id", TENANT)
    .gte("date_created_marketplace", START)
    .lt("date_created_marketplace", END);
  const eligible = (orders ?? []).filter(
    (o) =>
      isExecutiveSummaryEligibleOrderRow(o) && orderMatchesExecutivePeriod(o, periodResult.period),
  );
  const { data: items } = await sb
    .from("sales_order_items")
    .select("sales_order_id, raw_json")
    .in(
      "sales_order_id",
      eligible.map((o) => o.id),
    );

  let feeRebates = new Decimal(0);
  let shipBonus = new Decimal(0);
  /** @type {Set<string>} */
  const ordersWithCredit = new Set();
  let lineSum = new Decimal(0);

  for (const it of items ?? []) {
    const fin = it.raw_json?._s7_financial ?? {};
    const lineCredits = resolveMarketplaceSettlementCreditsFromItemFinancial(fin);
    lineSum = lineSum.plus(lineCredits);
    if (lineCredits.gt(0) && it.sales_order_id) {
      ordersWithCredit.add(String(it.sales_order_id));
    }

    const posAdj = fin.positive_adjustments_brl;
    if (posAdj != null) feeRebates = feeRebates.plus(posAdj);
    else {
      const rebate = fin.marketplace_rebate;
      if (rebate && typeof rebate === "object" && rebate.amount_brl != null) {
        feeRebates = feeRebates.plus(rebate.amount_brl);
      }
    }
    const bonus = fin.formula_debug?.selected_shipping_bonus?.amount;
    if (bonus != null) shipBonus = shipBonus.plus(bonus);
  }

  assert.equal(ordersWithCredit.size, 9);
  assert.equal(feeRebates.toFixed(2), "12.70");
  assert.equal(shipBonus.toFixed(2), "0.89");
  assert.equal(lineSum.toFixed(2), "13.59");
  assert.equal(money(summary.marketplace_settlement_credits_brl).toFixed(2), "13.59");
  assert.equal(lineSum.toFixed(2), money(summary.marketplace_settlement_credits_brl).toFixed(2));

  console.log("[OK] test_ssot_vendas_ao_vivo_settlement_credits_unit");
}

main().catch((err) => {
  console.error("[FAIL] test_ssot_vendas_ao_vivo_settlement_credits_unit", err.message);
  process.exit(1);
});
