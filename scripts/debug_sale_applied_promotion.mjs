/**
 * Debug: applied_sale_promotion para um pedido ML.
 * Uso (na pasta suse7-backend): node scripts/debug_sale_applied_promotion.mjs 2000016539534842
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const orderExt = process.argv[2] || "2000016539534842";
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, "..");

function loadEnv() {
  const p = resolve(backendRoot, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in suse7-backend/.env");
  process.exit(1);
}

const supabase = createClient(url, key);

const { resolveSaleAppliedPromotion, resolveEffectiveMercadoLivreSaleLine, resolveSaleGrossBrl } =
  await import("../src/domain/sales/saleDetailMarketplaceRevenue.js");

const { data: items, error: itemErr } = await supabase
  .from("sales_order_items")
  .select("*, sales_orders!inner(id, external_order_id, raw_json, marketplace_account_id)")
  .eq("sales_orders.external_order_id", orderExt)
  .limit(5);

if (itemErr) {
  console.error(itemErr);
  process.exit(1);
}

if (!items?.length) {
  console.log("No items for order", orderExt);
  process.exit(0);
}

for (const row of items) {
  const order = row.sales_orders;
  const item = { ...row };
  delete item.sales_orders;
  const line = resolveEffectiveMercadoLivreSaleLine(item, order);
  const gross = resolveSaleGrossBrl(item, line);
  const promo = resolveSaleAppliedPromotion(item, order);

  console.log("\n--- item", item.id, "---");
  console.log("external_listing_id", item.external_listing_id);
  console.log("gross_amount db", item.gross_amount);
  console.log("unit_price db", item.unit_price);
  if (line) {
    console.log("line.gross_price", line.gross_price);
    console.log("line.unit_price", line.unit_price);
    console.log("line.discounted_unit_price", line.discounted_unit_price);
    console.log("line.full_unit_price", line.full_unit_price);
    console.log("line.base_unit_price", line.base_unit_price);
  }
  const orderRaw = order?.raw_json;
  const fin = orderRaw?._s7_financial;
  console.log("has discounts_snapshot", Boolean(fin?.discounts_snapshot));
  console.log("sale gross resolved", gross?.gross?.toString());
  console.log("applied_sale_promotion", JSON.stringify(promo, null, 2));
}
