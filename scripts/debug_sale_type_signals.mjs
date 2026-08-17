/**
 * Debug sale type signals for a ML order.
 * Usage: node scripts/debug_sale_type_signals.mjs 2000016539534842
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, writeFileSync } from "fs";

const orderExt = process.argv[2] || "2000016539534842";

function loadEnv() {
  for (const p of [".env.local", ".env"]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

loadEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / key");
  process.exit(1);
}

const supabase = createClient(url, key);

const { data, error } = await supabase
  .from("sales_orders")
  .select("id,external_order_id,raw_json,user_id,marketplace_account_id")
  .eq("external_order_id", orderExt)
  .limit(1);

if (error) {
  console.error(error);
  process.exit(1);
}

const raw = data?.[0]?.raw_json;
if (!raw || typeof raw !== "object") {
  console.log("no order raw_json for", orderExt);
  process.exit(0);
}

const r = /** @type {Record<string, unknown>} */ (raw);
writeFileSync("scripts/tmp-order.json", JSON.stringify(r, null, 2));
console.log("tags", r.tags);
console.log("internal_tags", r.internal_tags);
console.log("channel", r.channel);
console.log("context", JSON.stringify(r.context));
console.log("advertising", r.advertising);

const items = Array.isArray(r.order_items) ? r.order_items : [];
console.log("order_items", items.length);
for (const it of items.slice(0, 3)) {
  const line = it && typeof it === "object" ? /** @type {Record<string, unknown>} */ (it) : {};
  console.log("--- line ---");
  console.log("  tags", line.tags);
  console.log("  advertising", line.advertising);
  console.log("  item", line.item);
  console.log("  sale_fee", line.sale_fee);
}

const fin = r._s7_financial;
if (fin && typeof fin === "object") {
  const f = /** @type {Record<string, unknown>} */ (fin);
  console.log("_s7_financial keys", Object.keys(f));
  if (f.discounts_snapshot) {
    console.log("discounts_snapshot", JSON.stringify(f.discounts_snapshot, null, 2).slice(0, 2000));
  }
}

function deepFind(obj, depth = 0) {
  if (depth > 6 || obj == null) return;
  if (typeof obj === "string") {
    if (/advertis|publicidade|product_ad|affiliat|afiliad|pads/i.test(obj)) {
      console.log("  str match:", obj.slice(0, 120));
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const x of obj) deepFind(x, depth + 1);
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (/advertis|publicidade|product_ad|affiliat|afiliad|pads|flow|channel|tag/i.test(k)) {
        console.log(`  key ${k}:`, JSON.stringify(v).slice(0, 200));
      }
    }
    for (const v of Object.values(obj)) deepFind(v, depth + 1);
  }
}

console.log("\n=== deep scan (ads/affiliate related) ===");
deepFind(r);

const blob = JSON.stringify(r);
const re = /advertis|publicidade|product_ad|affiliat|afiliad|pads|billed_ad|ad_sale/gi;
let m;
while ((m = re.exec(blob)) !== null) {
  console.log("blob match at", m.index, ":", blob.slice(Math.max(0, m.index - 40), m.index + 80));
}

if (fin && typeof fin === "object") {
  const f = /** @type {Record<string, unknown>} */ (fin);
  if (Array.isArray(f.lines)) {
    console.log("\n_s7_financial.lines[0] keys", Object.keys(f.lines[0] || {}));
    console.log("_s7_financial.lines sample", JSON.stringify(f.lines[0], null, 2).slice(0, 1500));
  }
}

const { data: itemRows } = await supabase
  .from("sales_order_items")
  .select("id,raw_json,financials,sales_orders!inner(external_order_id)")
  .eq("sales_orders.external_order_id", orderExt)
  .limit(1);

const itemRaw = itemRows?.[0]?.raw_json;
console.log("\nitem raw_json keys", itemRaw && typeof itemRaw === "object" ? Object.keys(itemRaw) : null);
if (itemRaw) {
  const ib = JSON.stringify(itemRaw);
  const re2 = /advertis|publicidade|product_ad|affiliat|afiliad/gi;
  let m2;
  while ((m2 = re2.exec(ib)) !== null) {
    console.log("item blob match:", ib.slice(Math.max(0, m2.index - 40), m2.index + 80));
  }
}
console.log("item financials", JSON.stringify(itemRows?.[0]?.financials)?.slice(0, 500));

console.log("\norder top-level keys", Object.keys(r).sort().join(", "));
console.log("static_tags", r.static_tags);
console.log("buying_mode", r.buying_mode);
console.log("mediations", JSON.stringify(r.mediations)?.slice(0, 400));
console.log("order_request", JSON.stringify(r.order_request)?.slice(0, 400));
console.log("related_orders", r.related_orders);
console.log("pack_id", r.pack_id);
console.log("payments sample", JSON.stringify(r.payments)?.slice(0, 1200));
console.log("taxes", JSON.stringify(r.taxes)?.slice(0, 600));
if (fin && typeof fin === "object" && Array.isArray(fin.lines)) {
  console.log("_s7_financial.lines", JSON.stringify(fin.lines, null, 2).slice(0, 2500));
}

const { data: withD2c } = await supabase
  .from("sales_orders")
  .select("external_order_id,raw_json")
  .eq("marketplace", "mercado_livre")
  .contains("raw_json", { tags: ["d2c"] })
  .limit(3);
const { data: withoutD2c } = await supabase
  .from("sales_orders")
  .select("external_order_id,raw_json")
  .eq("marketplace", "mercado_livre")
  .not("raw_json", "cs", '{"tags":["d2c"]}')
  .limit(3);
console.log("\ncompare d2c vs non-d2c order ids:");
console.log("with d2c", withD2c?.map((x) => x.external_order_id));
console.log("without d2c sample tags", withoutD2c?.map((x) => x.raw_json?.tags));

try {
  const { fetchOrderById } = await import("../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js");
  const accountId = r.seller?.id ?? data?.[0]?.marketplace_account_id;
  const { data: acc } = await supabase
    .from("marketplace_accounts")
    .select("id,external_seller_id")
    .eq("external_order_id", orderExt)
    .limit(1);
  void acc;
  const macc = data?.[0]?.marketplace_account_id;
  const uid = data?.[0]?.user_id;
  if (macc && uid) {
    const { data: acc } = await supabase
      .from("marketplace_accounts")
      .select("external_seller_id")
      .eq("id", macc)
      .maybeSingle();
    const mlUser = acc?.external_seller_id;
    const { data: toks } = await supabase
      .from("ml_tokens")
      .select("access_token,ml_user_id")
      .eq("user_id", uid)
      .eq("marketplace", "mercado_livre");
    const tok =
      (toks || []).find((t) => String(t.ml_user_id) === String(mlUser)) ?? (toks || [])[0];
    if (tok?.access_token) {
      const { fetchMercadoLivreOrderDiscountsById } = await import(
        "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js"
      );
      const live = await fetchOrderById(tok.access_token, orderExt, { marketplaceAccountId: macc });
      const disc = await fetchMercadoLivreOrderDiscountsById(tok.access_token, orderExt, {
        marketplaceAccountId: macc,
      });
      console.log("\nLIVE discounts", JSON.stringify(disc)?.slice(0, 1500));
      console.log("\nLIVE order tags", live?.tags);
      console.log("LIVE internal_tags", live?.internal_tags);
      console.log("LIVE context", live?.context);
      console.log("LIVE advertising", live?.advertising);
      const lb = JSON.stringify(live);
      const re3 = /advertis|publicidade|product_ad|affiliat|afiliad|pads|billed/gi;
      let m3;
      while ((m3 = re3.exec(lb)) !== null) {
        console.log("LIVE blob:", lb.slice(Math.max(0, m3.index - 50), m3.index + 100));
      }
      const itemId = "MLB6086959274";
      const paMetricsUrl = `https://api.mercadolibre.com/advertising/MLB/product_ads/ads/${itemId}?date_from=2026-05-21&date_to=2026-05-21&metrics=advertising_items_quantity,direct_items_quantity,indirect_items_quantity,organic_items_quantity,units_quantity`;
      try {
        const res = await fetch(paMetricsUrl, {
          headers: { Authorization: `Bearer ${tok.access_token}`, "api-version": "2" },
        });
        const paTxt = await res.text();
        writeFileSync("scripts/tmp-pa-metrics.json", paTxt);
        console.log("\nPADS item day metrics", res.status, paTxt.slice(0, 1200));
      } catch (e) {
        console.log("PADS metrics fail", e?.message);
      }
      for (const path of [
        `https://api.mercadolibre.com/advertising/product_ads/items/${itemId}`,
        `https://api.mercadolibre.com/advertising/advertisers?product_id=PADS`,
        `https://api.mercadolibre.com/advertising/product_ads/orders/${orderExt}`,
        `https://api.mercadolibre.com/advertising/product_ads/sales/${orderExt}`,
        `https://api.mercadolibre.com/advertising/product_ads/attribution/orders/${orderExt}`,
        `https://api.mercadolibre.com/marketplace/orders/${orderExt}/product_ads`,
      ]) {
        try {
          const res = await fetch(path, {
            headers: { Authorization: `Bearer ${tok.access_token}` },
          });
          const txt = await res.text();
          console.log("\nPADS probe", path, res.status, txt.slice(0, 600));
        } catch (e) {
          console.log("PADS probe fail", path, e?.message);
        }
      }
    } else {
      console.log("no token for account", macc, "uid", uid, "toks", toks?.length ?? 0);
    }
  }
} catch (e) {
  console.log("live fetch skipped", e?.message ?? e);
}
