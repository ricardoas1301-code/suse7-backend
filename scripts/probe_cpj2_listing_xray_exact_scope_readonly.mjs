#!/usr/bin/env node
/**
 * CPJ2 Lote 6 — prova read-only do filtro exato de anúncio vs busca q/ILIKE.
 * DATABASE_MUTATION=0
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { saleDetailToQty } from "../src/domain/sales/saleDetailInternalCosts.js";
import { isExecutiveSummaryEligibleOrderRow } from "../src/domain/sales/saleExecutiveOrderValidity.js";
import { expandExactExternalListingIds } from "../src/domain/sales/resolverFiltroExatoListingIdLista.js";

const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";
const OPEN_LISTING_ID = process.env.OPEN_LISTING_ID || "MLB4709614771";
const PRODUCT_ID = process.env.PRODUCT_ID || "5669593c-fccd-4fee-8dc6-8390ab464d3e";
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

const env = parseDotEnv(T11_ENV);
const supabase = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const exactIds = expandExactExternalListingIds(OPEN_LISTING_ID);

const { data: exactRows, error: exactErr } = await supabase
  .from("sales_order_items")
  .select("id,quantity,sales_order_id,external_listing_id,marketplace,marketplace_account_id,title_snapshot,sku_snapshot,external_order_id,user_id")
  .eq("user_id", USER_ID)
  .in("external_listing_id", exactIds)
  .limit(8000);
if (exactErr) throw exactErr;

const ilikeToken = OPEN_LISTING_ID.replace(/[%_]/g, "");
const { count: ilikeCount, error: ilikeErr } = await supabase
  .from("sales_order_items")
  .select("id", { count: "exact", head: true })
  .eq("user_id", USER_ID)
  .or(
    [
      `title_snapshot.ilike.%${ilikeToken}%`,
      `sku_snapshot.ilike.%${ilikeToken}%`,
      `external_listing_id.ilike.%${ilikeToken}%`,
      `external_order_item_id.ilike.%${ilikeToken}%`,
      `external_order_id.ilike.%${ilikeToken}%`,
    ].join(","),
  );
if (ilikeErr) throw ilikeErr;

const orderIds = [...new Set((exactRows || []).map((r) => r.sales_order_id).filter(Boolean))];
const orders = new Map();
for (let i = 0; i < orderIds.length; i += 150) {
  const { data, error: oerr } = await supabase
    .from("sales_orders")
    .select("id,order_status,order_substatus,raw_json,date_created_marketplace,user_id")
    .eq("user_id", USER_ID)
    .in("id", orderIds.slice(i, i + 150));
  if (oerr) throw oerr;
  for (const o of data || []) orders.set(String(o.id), o);
}

const rawExactRows = exactRows || [];
const eligible = rawExactRows.filter((row) => {
  const order = orders.get(String(row.sales_order_id ?? ""));
  return Boolean(order && isExecutiveSummaryEligibleOrderRow(order));
});

const foreignListingRows = rawExactRows.filter((row) => {
  const ext = String(row.external_listing_id ?? "").trim();
  return !exactIds.includes(ext);
});

const units = eligible.reduce((acc, row) => acc + saleDetailToQty(row.quantity), 0);
const accounts = [...new Set(rawExactRows.map((r) => String(r.marketplace_account_id ?? "").trim()).filter(Boolean))];
const marketplaces = [...new Set(rawExactRows.map((r) => String(r.marketplace ?? "").trim()).filter(Boolean))];

const sorted = [...rawExactRows].sort((a, b) => String(b.id).localeCompare(String(a.id)));
const page1 = sorted.slice(0, 100);
const page2 = sorted.slice(100, 200);
const page1Foreign = page1.filter((row) => !exactIds.includes(String(row.external_listing_id ?? "").trim()));
const page2Foreign = page2.filter((row) => !exactIds.includes(String(row.external_listing_id ?? "").trim()));

const similarId = `${OPEN_LISTING_ID}9`;
const { count: similarCount, error: similarErr } = await supabase
  .from("sales_order_items")
  .select("id", { count: "exact", head: true })
  .eq("user_id", USER_ID)
  .in("external_listing_id", expandExactExternalListingIds(OPEN_LISTING_ID).filter((id) => id === similarId));
if (similarErr) throw similarErr;

const { data: listingMeta } = await supabase
  .from("marketplace_listings")
  .select("external_listing_id,product_id,marketplace,marketplace_account_id")
  .eq("user_id", USER_ID)
  .in("external_listing_id", exactIds)
  .limit(5);

const { data: productListings } = await supabase
  .from("marketplace_listings")
  .select("external_listing_id")
  .eq("user_id", USER_ID)
  .eq("product_id", PRODUCT_ID);

const productListingIds = [...new Set((productListings || []).map((r) => String(r.external_listing_id ?? "").trim()).filter(Boolean))];

const { data: productRows, error: productErr } = await supabase
  .from("sales_order_items")
  .select("id,quantity,sales_order_id,external_listing_id")
  .eq("user_id", USER_ID)
  .in("external_listing_id", productListingIds.length ? productListingIds : ["__none__"])
  .limit(8000);
if (productErr) throw productErr;

const productOrderIds = [...new Set((productRows || []).map((r) => r.sales_order_id).filter(Boolean))];
const productOrders = new Map();
for (let i = 0; i < productOrderIds.length; i += 150) {
  const { data, error: oerr } = await supabase
    .from("sales_orders")
    .select("id,order_status,order_substatus,raw_json,date_created_marketplace")
    .eq("user_id", USER_ID)
    .in("id", productOrderIds.slice(i, i + 150));
  if (oerr) throw oerr;
  for (const o of data || []) productOrders.set(String(o.id), o);
}

const productEligible = (productRows || []).filter((row) => {
  const order = productOrders.get(String(row.sales_order_id ?? ""));
  return Boolean(order && isExecutiveSummaryEligibleOrderRow(order));
});
const productRaw = productRows || [];
const productForeign = productRaw.filter((row) => !productListingIds.includes(String(row.external_listing_id ?? "").trim()));
const productUnits = productEligible.reduce((acc, row) => acc + saleDetailToQty(row.quantity), 0);

const { count: otherSellerCount, error: otherSellerErr } = await supabase
  .from("sales_order_items")
  .select("id", { count: "exact", head: true })
  .in("external_listing_id", exactIds)
  .neq("user_id", USER_ID);
if (otherSellerErr) throw otherSellerErr;

process.stdout.write(
  `${JSON.stringify(
    {
      OPEN_LISTING_ID,
      MARKETPLACE: marketplaces,
      MARKETPLACE_ACCOUNT_SCOPE: accounts,
      exactIds,
      LIFETIME_SALES_UNITS: units,
      LIFETIME_ORDER_ITEM_ROWS: rawExactRows.length,
      SERVER_PAGINATION_TOTAL: rawExactRows.length,
      EXPECTED_TOTAL_PAGES: Math.max(1, Math.ceil(rawExactRows.length / 100)),
      RETURNED_ROWS_PAGE_1: page1.length,
      RETURNED_ROWS_PAGE_2: page2.length,
      PAGE_1_FOREIGN: page1Foreign.length,
      PAGE_2_FOREIGN: page2Foreign.length,
      EXACT_FILTER_FOREIGN_ROWS: foreignListingRows.length,
      Q_ILIKE_COUNT: ilikeCount ?? 0,
      Q_ILIKE_INFLATION: Math.max(0, Number(ilikeCount ?? 0) - rawExactRows.length),
      SIMILAR_ID_IN_EXACT_SET: similarCount ?? 0,
      OTHER_SELLER_ROWS: otherSellerCount ?? 0,
      listingMeta: listingMeta ?? [],
      PRODUCT_ID,
      LINKED_LISTING_COUNT: productListingIds.length,
      PRODUCT_LIFETIME_SALES_UNITS: productUnits,
      PRODUCT_LIFETIME_ORDER_ITEM_ROWS: productRaw.length,
      PRODUCT_SERVER_PAGINATION_TOTAL: productRaw.length,
      PRODUCT_EXPECTED_TOTAL_PAGES: Math.max(1, Math.ceil(productRaw.length / 100)),
      PRODUCT_FOREIGN_ROWS: productForeign.length,
      DEFENSIVE_FILTER_DROPPED_ROWS: foreignListingRows.length,
    },
    null,
    2,
  )}\n`,
);
