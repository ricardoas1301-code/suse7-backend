#!/usr/bin/env node
/**
 * FIN.SSOT.SNAPSHOT-IMMUTABILITY.01 — prova pós-deploy DEV
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildSaleExecutiveSummary } from "../src/domain/sales/buildSaleExecutiveSummary.js";
import { resolveExecutiveSummaryPeriod } from "../src/domain/sales/saleExecutivePeriod.js";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local") });
dotenv.config({ path: path.join(root, ".env.vercel") });

const TENANT = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const GOLDEN_START = "2026-08-07T21:00:00.000Z";
const GOLDEN_END = "2026-08-10T21:00:00.000Z";
const TEST_ORDERS = [
  "2000017855918634",
  "2000017856064294",
  "2000017855961990",
];
const DEPLOY_TS = process.env.S7_DEPLOY_TS || new Date().toISOString();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function money(v) {
  if (v == null) return null;
  return String(v);
}

async function goldenSummary() {
  const period = resolveExecutiveSummaryPeriod({
    start_datetime: GOLDEN_START,
    end_datetime: GOLDEN_END,
    period_preset: "operational_cycle",
  });
  const payload = await buildSaleExecutiveSummary(sb, TENANT, {
    period: period.period,
    marketplace: "mercado_livre",
  });
  const s = payload.summary ?? {};
  return {
    orders_count: s.orders_count,
    gross_sales_brl: money(s.gross_sales_brl),
    marketplace_fee_brl: money(s.marketplace_fee_brl),
    shipping_cost_brl: money(s.shipping_cost_brl),
    net_received_brl: money(s.net_received_brl),
    tax_cost_brl: money(s.tax_cost_brl),
    product_cost_only_brl: money(s.product_cost_only_brl),
    operation_packaging_cost_brl: money(s.operation_packaging_cost_brl),
    ads_cost_brl: money(s.ads_cost_brl),
    operational_costs_brl: money(s.operational_costs_brl),
    contribution_profit_brl: money(s.contribution_profit_brl),
    contribution_margin_percent: money(s.contribution_margin_percent),
  };
}

async function orderFingerprint(externalOrderId) {
  const { data: so } = await sb
    .from("sales_orders")
    .select("id")
    .eq("external_order_id", externalOrderId)
    .maybeSingle();
  const { data: items } = await sb
    .from("sales_order_items")
    .select("fee_amount, shipping_share_amount, net_amount, raw_json")
    .eq("sales_order_id", so?.id);
  const it = items?.[0];
  const fin = it?.raw_json?._s7_financial ?? {};
  const internal = fin.internal_costs_snapshot ?? {};
  const tax = fin.tax_snapshot ?? {};
  const product = fin.product_cost_snapshot ?? {};
  const op = fin.operational_cost_snapshot ?? {};
  const ads = fin.ads_snapshot ?? {};
  const contingency = fin.contingency_margin_snapshot ?? {};
  return {
    order: externalOrderId,
    snapshot_created_at: fin.snapshot_created_at ?? null,
    immutable_since: fin.immutable_since ?? null,
    tax_percent_applied: tax.tax_percent_applied ?? internal.tax_percent_applied ?? null,
    internal_tax_brl: tax.amount_brl ?? internal.internal_tax_brl ?? null,
    product_cost_brl: product.amount_brl ?? internal.product_cost_brl ?? null,
    operation_cost_brl: op.operation_cost_brl ?? internal.operation_cost_brl ?? null,
    packaging_cost_brl: op.packaging_cost_brl ?? internal.packaging_cost_brl ?? null,
    operation_packaging_cost_brl:
      op.operation_packaging_cost_brl ?? internal.operation_packaging_cost_brl ?? null,
    ads_amount_brl: ads.amount_brl ?? ads.ml_ads_brl ?? contingency.ml_ads_brl ?? null,
    reserve_brl: contingency.reserve_brl ?? contingency.safety_reserve_brl ?? op.reserve_brl ?? null,
    fee_col: money(it?.fee_amount),
    shipping_col: money(it?.shipping_share_amount),
    net_col: money(it?.net_amount),
    fee_fin: money(fin.marketplace_fee_amount_brl),
    shipping_fin: money(fin.shipping_amount_brl),
    net_fin: money(fin.net_received_amount_brl),
    has_s7_financial: Boolean(it?.raw_json?._s7_financial),
    snapshot_complete: fin.snapshot_complete ?? null,
  };
}

function syncOrder(orderId) {
  execSync(`node scripts/sync_ml_orders_by_id.mjs ${orderId}`, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
}

async function countSilentRebuildsAfterDeploy() {
  const { data: items } = await sb
    .from("sales_order_items")
    .select("id, raw_json, updated_at")
    .eq("user_id", TENANT)
    .gte("updated_at", DEPLOY_TS);
  let rebuilt = 0;
  for (const it of items ?? []) {
    const fin = it.raw_json?._s7_financial;
    const created = fin?.snapshot_created_at != null ? String(fin.snapshot_created_at) : "";
    if (created && created >= DEPLOY_TS) rebuilt += 1;
  }
  return { items_updated_after_deploy: items?.length ?? 0, new_snapshot_created_at: rebuilt };
}

async function main() {
  console.log(JSON.stringify({ step: "deploy_meta", commit: "22e4a5c", deploy_ts: DEPLOY_TS }, null, 2));

  const goldenA = await goldenSummary();
  console.log(JSON.stringify({ step: "GOLDEN_POST_FIX_A", ...goldenA }, null, 2));

  const before = {};
  for (const oid of TEST_ORDERS) {
    before[oid] = await orderFingerprint(oid);
  }
  console.log(JSON.stringify({ step: "fingerprints_before", before }, null, 2));

  const tenXOrder = "2000017855918634";
  for (let i = 1; i <= 10; i++) {
    syncOrder(tenXOrder);
    console.log(JSON.stringify({ step: "reprocess_10x", iteration: i, order: tenXOrder }));
  }

  for (const oid of TEST_ORDERS) {
    syncOrder(oid);
    console.log(JSON.stringify({ step: "reprocess_test_order", order: oid }));
  }

  const after = {};
  const deltas = {};
  for (const oid of TEST_ORDERS) {
    after[oid] = await orderFingerprint(oid);
    const b = before[oid];
    const a = after[oid];
    /** @type {Record<string, string>} */
    const d = {};
    for (const key of Object.keys(b)) {
      if (key === "order") continue;
      d[key] = JSON.stringify(b[key]) === JSON.stringify(a[key]) ? "0" : `${b[key]} -> ${a[key]}`;
    }
    deltas[oid] = d;
  }
  console.log(JSON.stringify({ step: "fingerprints_after", after }, null, 2));
  console.log(JSON.stringify({ step: "fingerprints_delta", deltas }, null, 2));

  const goldenB = await goldenSummary();
  console.log(JSON.stringify({ step: "GOLDEN_POST_FIX_B", ...goldenB }, null, 2));

  const histKeys = [
    "tax_cost_brl",
    "product_cost_only_brl",
    "operation_packaging_cost_brl",
    "ads_cost_brl",
    "operational_costs_brl",
    "contribution_profit_brl",
    "contribution_margin_percent",
  ];
  /** @type {Record<string, string>} */
  const goldenDelta = {};
  for (const k of histKeys) {
    goldenDelta[k] =
      goldenA[k] === goldenB[k] ? "0" : `${goldenA[k]} -> ${goldenB[k]}`;
  }
  console.log(JSON.stringify({ step: "GOLDEN_A_vs_B", goldenDelta }, null, 2));

  const monitor = await countSilentRebuildsAfterDeploy();
  console.log(JSON.stringify({ step: "monitor_post_deploy", ...monitor, test_orders_excluded: TEST_ORDERS.length }, null, 2));
}

main().catch((err) => {
  console.error("[FAIL] prove_snapshot_immutability", err);
  process.exit(1);
});
