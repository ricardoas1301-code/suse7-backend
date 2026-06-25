#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildSaleExecutiveSummary } from "../src/domain/sales/buildSaleExecutiveSummary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(root, ".env.vercel")),
  ...parseDotEnv(path.join(root, ".env.local")),
};

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes no ambiente local.");
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const sellers = [
  { id: "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50", label: "RF Moveis" },
  { id: "7f351439-ea13-44de-8a9c-a2413713f6e4", label: "Super Metalrio" },
];

const period = {
  preset: "custom",
  start_date: "2026-05-24",
  end_date: "2026-06-23",
  start_ms: Date.parse("2026-05-24T00:00:00.000Z"),
  end_ms_exclusive: Date.parse("2026-06-24T00:00:00.000Z"),
};

const startIso = new Date(period.start_ms).toISOString();
const endIso = new Date(period.end_ms_exclusive).toISOString();
const EXCLUDED = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "invalid",
  "rejected",
  "payment_rejected",
  "payment_refunded",
  "charged_back",
]);

for (const seller of sellers) {
  const summaryPayload = await buildSaleExecutiveSummary(supabase, seller.id, {
    period,
  });

  const { data: orderRows, error: orderErr } = await supabase
    .from("sales_orders")
    .select("id,order_status,order_substatus")
    .eq("user_id", seller.id)
    .gte("date_created_marketplace", startIso)
    .lt("date_created_marketplace", endIso);

  if (orderErr) throw orderErr;

  const eligibleOrderIds = (orderRows || [])
    .filter((row) => {
      const status = String(row.order_status ?? "").trim().toLowerCase();
      const substatus = String(row.order_substatus ?? "").trim().toLowerCase();
      return (!status || !EXCLUDED.has(status)) && (!substatus || !EXCLUDED.has(substatus));
    })
    .map((row) => String(row.id));

  let itemRows = 0;
  const chunkSize = 100;
  for (let i = 0; i < eligibleOrderIds.length; i += chunkSize) {
    const chunk = eligibleOrderIds.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const { data: items, error: itemErr } = await supabase
      .from("sales_order_items")
      .select("id")
      .eq("user_id", seller.id)
      .in("sales_order_id", chunk);
    if (itemErr) throw itemErr;
    itemRows += Array.isArray(items) ? items.length : 0;
  }

  const uniqueOrders = new Set(eligibleOrderIds).size;
  const summary = summaryPayload?.summary ?? {};

  console.log(
    JSON.stringify(
      {
        seller: seller.label,
        period: { start: period.start_date, end: period.end_date },
        rootCauseSnapshot: {
          resumo_diario_orders_count: summary.orders_count ?? 0,
          top10_antes_items_quantity_sold: summary.items_quantity_sold ?? 0,
          lista_antes_item_rows: itemRows,
          lista_orders_distinct_ssot: uniqueOrders,
        },
        financialKpis: {
          gross_sales_brl: summary.gross_sales_brl ?? null,
          net_profit_brl: summary.net_profit_brl ?? null,
          contribution_margin_percent: summary.contribution_margin_percent ?? null,
          you_receive_brl: summary.you_receive_brl ?? null,
          product_cost_only_brl: summary.product_cost_only_brl ?? null,
          marketplace_fee_brl: summary.marketplace_fee_brl ?? null,
          shipping_cost_brl: summary.shipping_cost_brl ?? null,
          tax_cost_brl: summary.tax_cost_brl ?? null,
          ads_cost_brl: summary.ads_cost_brl ?? null,
        },
      },
      null,
      2,
    ),
  );
}
