#!/usr/bin/env node
/**
 * CPJ2 Lote 6 — prova read-only: lifetime vs 60d vs unidades (sem UPDATE).
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { saleDetailToQty } from "../src/domain/sales/saleDetailInternalCosts.js";
import { isExecutiveSummaryEligibleOrderRow } from "../src/domain/sales/saleExecutiveOrderValidity.js";

const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";
const T11_ENV = "C:\\ProjetosDev\\_rc-worktrees\\backend-cpj2-t1-reconnect-cta\\.env.local";

function parseDotEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[line.slice(0, idx).trim()] = val;
  }
  return out;
}

function window60d() {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(todayUtc);
  start.setUTCDate(start.getUTCDate() - 59);
  return { startMs: start.getTime(), endMsExclusive: todayUtc.getTime() + 24 * 60 * 60 * 1000 };
}

const env = parseDotEnv(T11_ENV);
const supabase = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { startMs, endMsExclusive } = window60d();

const { data: items, error } = await supabase
  .from("sales_order_items")
  .select("id,quantity,sales_order_id,external_listing_id,marketplace_account_id")
  .eq("user_id", USER_ID)
  .limit(8000);
if (error) throw error;

const orderIds = [...new Set((items || []).map((r) => r.sales_order_id).filter(Boolean))];
const orders = new Map();
for (let i = 0; i < orderIds.length; i += 150) {
  const { data, error: oerr } = await supabase
    .from("sales_orders")
    .select("id,order_status,order_substatus,raw_json,date_created_marketplace")
    .eq("user_id", USER_ID)
    .in("id", orderIds.slice(i, i + 150));
  if (oerr) throw oerr;
  for (const o of data || []) orders.set(String(o.id), o);
}

function in60d(order) {
  const t = Date.parse(String(order?.date_created_marketplace ?? ""));
  if (!Number.isFinite(t)) return false;
  return t >= startMs && t < endMsExclusive;
}

const byListing = new Map();
for (const row of items || []) {
  const order = orders.get(String(row.sales_order_id ?? ""));
  if (!order || !isExecutiveSummaryEligibleOrderRow(order)) continue;
  const ext = String(row.external_listing_id ?? "").trim();
  if (!ext) continue;
  const prev = byListing.get(ext) || {
    recordsLife: 0,
    unitsLife: 0,
    records60: 0,
    units60: 0,
    ordersLife: new Set(),
    orders60: new Set(),
    minDate: null,
    maxDate: null,
    accountIds: new Set(),
  };
  const qty = saleDetailToQty(row.quantity);
  const ts = Date.parse(String(order.date_created_marketplace ?? ""));
  prev.recordsLife += 1;
  prev.unitsLife += qty;
  if (row.sales_order_id) prev.ordersLife.add(String(row.sales_order_id));
  if (row.marketplace_account_id) prev.accountIds.add(String(row.marketplace_account_id));
  if (Number.isFinite(ts)) {
    const iso = new Date(ts).toISOString();
    if (!prev.minDate || iso < prev.minDate) prev.minDate = iso;
    if (!prev.maxDate || iso > prev.maxDate) prev.maxDate = iso;
  }
  if (in60d(order)) {
    prev.records60 += 1;
    prev.units60 += qty;
    if (row.sales_order_id) prev.orders60.add(String(row.sales_order_id));
  }
  byListing.set(ext, prev);
}

const listings = [...byListing.entries()].map(([id, v]) => ({
  listing: id,
  unitsLife: v.unitsLife,
  recordsLife: v.recordsLife,
  ordersLife: v.ordersLife.size,
  units60: v.units60,
  records60: v.records60,
  orders60: v.orders60.size,
  pagesLife: Math.max(1, Math.ceil(v.recordsLife / 100)),
  pages60: Math.max(1, Math.ceil(v.records60 / 100)),
  minDate: v.minDate,
  maxDate: v.maxDate,
  accounts: [...v.accountIds],
}));

const near170 = [...listings].sort((a, b) => Math.abs(a.unitsLife - 170) - Math.abs(b.unitsLife - 170)).slice(0, 3);

const { data: listingRows } = await supabase
  .from("marketplace_listings")
  .select("external_listing_id,product_id,marketplace_account_id")
  .eq("user_id", USER_ID)
  .not("product_id", "is", null);

const byProduct = new Map();
for (const row of listingRows || []) {
  const pid = String(row.product_id);
  const ext = String(row.external_listing_id ?? "").trim();
  if (!byProduct.has(pid)) byProduct.set(pid, new Set());
  if (ext) byProduct.get(pid).add(ext);
}

const products = [...byProduct.entries()].map(([pid, set]) => {
  let unitsLife = 0;
  let recordsLife = 0;
  let units60 = 0;
  let records60 = 0;
  const orderLife = new Set();
  const order60 = new Set();
  const perListing = [];
  for (const ext of set) {
    const v = byListing.get(ext);
    if (!v) {
      perListing.push({ listing: ext, unitsLife: 0, recordsLife: 0, units60: 0, records60: 0 });
      continue;
    }
    unitsLife += v.unitsLife;
    recordsLife += v.recordsLife;
    units60 += v.units60;
    records60 += v.records60;
    for (const o of v.ordersLife) orderLife.add(o);
    for (const o of v.orders60) order60.add(o);
    perListing.push({
      listing: ext,
      unitsLife: v.unitsLife,
      recordsLife: v.recordsLife,
      units60: v.units60,
      records60: v.records60,
    });
  }
  return {
    product_id: pid,
    listings: [...set].length,
    unitsLife,
    recordsLife,
    ordersLife: orderLife.size,
    units60,
    records60,
    orders60: order60.size,
    pagesLife: Math.max(1, Math.ceil(recordsLife / 100)),
    pages60: Math.max(1, Math.ceil(records60 / 100)),
    perListing: perListing.sort((a, b) => b.unitsLife - a.unitsLife).slice(0, 8),
  };
});

const near445 = [...products].sort((a, b) => Math.abs(a.unitsLife - 445) - Math.abs(b.unitsLife - 445)).slice(0, 3);
const mostUnits = [...products].sort((a, b) => b.unitsLife - a.unitsLife).slice(0, 3);

process.stdout.write(
  `${JSON.stringify(
    {
      window60d: {
        start: new Date(startMs).toISOString(),
        endExclusive: new Date(endMsExclusive).toISOString(),
      },
      grain: "ORDER_ITEM (sales_order_items row)",
      near170,
      near445,
      mostUnits,
    },
    null,
    2,
  )}\n`,
);
