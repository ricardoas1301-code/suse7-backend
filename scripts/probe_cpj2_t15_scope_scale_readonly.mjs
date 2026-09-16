#!/usr/bin/env node
/**
 * CPJ2-T15 microgate — leitura DEV somente (sem EXPLAIN ANALYZE, sem UPDATE).
 * Uso: node ./scripts/probe_cpj2_t15_scope_scale_readonly.mjs
 */
import fs from "node:fs";
import path from "node:path";
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
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function listingCandidates(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const out = new Set([s]);
  const upper = s.toUpperCase();
  if (/^MLB\d+$/.test(upper)) out.add(upper.slice(3));
  if (/^\d+$/.test(s)) {
    out.add(`MLB${s}`);
    out.add(s);
  }
  return [...out];
}

async function countExact(supabase, table, eq) {
  let q = supabase.from(table).select("id", { count: "exact", head: true }).eq("user_id", USER_ID);
  for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
  const { count, error } = await q;
  if (error) throw error;
  return Number(count) || 0;
}

const env = parseDotEnv(T11_ENV);
const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(JSON.stringify({ ok: false, error: "env_missing" }));
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const t0 = Date.now();

const sellerOrders = await countExact(supabase, "sales_orders", {});
const sellerItems = await countExact(supabase, "sales_order_items", {});

const { data: topItems, error: topErr } = await supabase
  .from("sales_order_items")
  .select("external_listing_id,quantity,sales_order_id,marketplace_account_id")
  .eq("user_id", USER_ID)
  .not("external_listing_id", "is", null)
  .limit(4000);
if (topErr) throw topErr;

const byListing = new Map();
for (const row of topItems || []) {
  const ext = String(row.external_listing_id ?? "").trim();
  if (!ext) continue;
  const prev = byListing.get(ext) || { rows: 0, qty: 0, account: row.marketplace_account_id };
  prev.rows += 1;
  prev.qty += saleDetailToQty(row.quantity);
  byListing.set(ext, prev);
}

const ranked = [...byListing.entries()].sort((a, b) => b[1].qty - a[1].qty);
const preferred = ranked.find(([, v]) => v.qty >= 100) || ranked[0];
if (!preferred) {
  console.log(JSON.stringify({ ok: false, error: "no_listing_with_items", sellerOrders, sellerItems }, null, 2));
  process.exit(0);
}

const listingId = preferred[0];
const candidates = listingCandidates(listingId);

const { data: listingRows, error: listingErr } = await supabase
  .from("marketplace_listings")
  .select("id,external_listing_id,product_id,marketplace_account_id,user_id")
  .eq("user_id", USER_ID)
  .in("external_listing_id", candidates);
if (listingErr) throw listingErr;

const listingRow = (listingRows || [])[0] || null;
const productId = listingRow?.product_id ? String(listingRow.product_id) : null;
const accountId = listingRow?.marketplace_account_id ? String(listingRow.marketplace_account_id) : null;

const { data: exactItems, error: exactErr } = await supabase
  .from("sales_order_items")
  .select("id,quantity,sales_order_id,external_listing_id,marketplace_account_id,user_id")
  .eq("user_id", USER_ID)
  .in("external_listing_id", candidates);
if (exactErr) throw exactErr;

const orderIds = [...new Set((exactItems || []).map((r) => r.sales_order_id).filter(Boolean))];
/** @type {Map<string, Record<string, unknown>>} */
const ordersById = new Map();
for (let i = 0; i < orderIds.length; i += 150) {
  const chunk = orderIds.slice(i, i + 150);
  const { data, error } = await supabase
    .from("sales_orders")
    .select("id,order_status,order_substatus,user_id,marketplace_account_id,raw_json")
    .eq("user_id", USER_ID)
    .in("id", chunk);
  if (error) throw error;
  for (const o of data || []) ordersById.set(String(o.id), o);
}

let eligibleRows = 0;
let sumQty = 0;
let foreignUser = 0;
let foreignAccount = 0;
for (const item of exactItems || []) {
  if (String(item.user_id) !== USER_ID) foreignUser += 1;
  if (accountId && item.marketplace_account_id && String(item.marketplace_account_id) !== accountId) {
    foreignAccount += 1;
  }
  const order = ordersById.get(String(item.sales_order_id ?? ""));
  if (order && !isExecutiveSummaryEligibleOrderRow(order)) continue;
  eligibleRows += 1;
  sumQty += saleDetailToQty(item.quantity);
}

const ilikeToken = listingId.replace(/^MLB/i, "");
const { data: ilikeItems, error: ilikeErr } = await supabase
  .from("sales_order_items")
  .select("id,external_listing_id")
  .eq("user_id", USER_ID)
  .or(
    `external_listing_id.ilike.*${ilikeToken}*,title_snapshot.ilike.*${ilikeToken}*,sku_snapshot.ilike.*${ilikeToken}*`,
  )
  .limit(2000);
if (ilikeErr) throw ilikeErr;

const expectedSet = new Set(candidates.map((c) => c.toUpperCase()));
const ilikeExtras = (ilikeItems || []).filter((row) => {
  const ext = String(row.external_listing_id ?? "").trim().toUpperCase();
  return ext && !expectedSet.has(ext) && !candidates.includes(String(row.external_listing_id));
});

let productListings = [];
let productExactItems = 0;
let productSum = 0;
if (productId) {
  const { data: linked, error: linkedErr } = await supabase
    .from("marketplace_listings")
    .select("external_listing_id,user_id")
    .eq("user_id", USER_ID)
    .eq("product_id", productId);
  if (linkedErr) throw linkedErr;
  productListings = (linked || [])
    .map((r) => String(r.external_listing_id ?? "").trim())
    .filter(Boolean);
  const productCandidates = [...new Set(productListings.flatMap((id) => listingCandidates(id)))];
  if (productCandidates.length) {
    const { data: pItems, error: pErr } = await supabase
      .from("sales_order_items")
      .select("quantity,sales_order_id,external_listing_id")
      .eq("user_id", USER_ID)
      .in("external_listing_id", productCandidates);
    if (pErr) throw pErr;
    productExactItems = (pItems || []).length;
    const pOrderIds = [...new Set((pItems || []).map((r) => r.sales_order_id).filter(Boolean))];
    const pOrders = new Map();
    for (let i = 0; i < pOrderIds.length; i += 150) {
      const chunk = pOrderIds.slice(i, i + 150);
      const { data, error } = await supabase
        .from("sales_orders")
        .select("id,order_status,order_substatus,raw_json")
        .eq("user_id", USER_ID)
        .in("id", chunk);
      if (error) throw error;
      for (const o of data || []) pOrders.set(String(o.id), o);
    }
    for (const item of pItems || []) {
      const order = pOrders.get(String(item.sales_order_id ?? ""));
      if (order && !isExecutiveSummaryEligibleOrderRow(order)) continue;
      productSum += saleDetailToQty(item.quantity);
    }
  }
}

const elapsed = Date.now() - t0;
const report = {
  ok: true,
  T15_CASE_TYPE: "LISTING",
  T15_LISTING_ID: listingId,
  T15_EXPECTED_LISTING_IDS: candidates,
  T15_INCLUDED_LISTING_IDS: [...new Set((exactItems || []).map((r) => String(r.external_listing_id)))],
  T15_ORDER_ITEM_ROWS: eligibleRows,
  T15_SUM_QUANTITY: sumQty,
  T15_DISPLAYED_SALES_EXPECTED: sumQty,
  T15_SCOPE_LEAK: ilikeExtras.length > 0 || foreignUser > 0 ? "YES" : "NO",
  T15_ILIKE_EXTRA_ROWS: ilikeExtras.length,
  T15_FOREIGN_USER_ROWS: foreignUser,
  T15_FOREIGN_ACCOUNT_ROWS: foreignAccount,
  T15_ACCOUNT_ID_PRESENT: Boolean(accountId),
  T15_PRODUCT_ID: productId,
  T15_PRODUCT_LINKED_LISTINGS: productListings,
  T15_PRODUCT_ITEM_ROWS: productExactItems,
  T15_PRODUCT_SUM_QUANTITY: productSum,
  T15_SELLER_ORDERS: sellerOrders,
  T15_SELLER_ITEMS_HEAD_COUNT: sellerItems,
  T15_SAMPLED_ITEMS_FOR_RANK: (topItems || []).length,
  T15_LISTING_PATH_ORDER_ID_PREFETCH: "account_or_user lifetime (preexistente)",
  T15_PRODUCT_PATH: "external_listing_id IN linked listings (sem varrer todos os pedidos)",
  T15_FILTER_LOCATION: "backend",
  T15_FRONTEND_RESUM: "NO",
  T15_PROBE_MS: elapsed,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
