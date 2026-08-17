/**
 * Diagnóstico contrato GET /api/sales/detail — promoção aplicada.
 * Uso: node scripts/debug_sale_detail_contract.mjs --order 2000016539534842
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (ou .env na raiz do backend).
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, "..");

dotenv.config({ path: resolve(backendRoot, ".env") });
dotenv.config({ path: resolve(backendRoot, ".env.local"), override: true });

const args = process.argv.slice(2);
let orderExt = "2000016539534842";
let itemIdArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--order" && args[i + 1]) orderExt = args[++i];
  if (args[i] === "--item-id" && args[i + 1]) itemIdArg = args[++i];
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("FALTAM SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente ou .env");
  process.exit(1);
}

const supabase = createClient(url, key);

const { buildSaleDetailMarketplaceRevenue, resolveSaleAppliedPromotion } = await import(
  "../src/domain/sales/saleDetailMarketplaceRevenue.js"
);
const { buildSaleDetailFinancialBreakdown } = await import("../src/handlers/sales/saleDetailFinancial.js");
const { findMercadoLivreOrderLine } = await import("../src/handlers/sales/_vendasSalesRows.js");

let item;
let order;

if (itemIdArg) {
  const { data, error } = await supabase
    .from("sales_order_items")
    .select("*, sales_orders(*)")
    .eq("id", itemIdArg)
    .maybeSingle();
  if (error) throw error;
  item = data;
  order = data?.sales_orders;
  if (item) delete item.sales_orders;
} else {
  const { data, error } = await supabase
    .from("sales_order_items")
    .select("*, sales_orders!inner(*)")
    .eq("sales_orders.external_order_id", orderExt)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  item = data;
  order = data?.sales_orders;
  if (item) delete item.sales_orders;
}

if (!item) {
  console.log("Item não encontrado para pedido", orderExt);
  process.exit(0);
}

const financial = buildSaleDetailFinancialBreakdown(item, null, order, null);
const mr =
  financial.marketplace_revenue && typeof financial.marketplace_revenue === "object"
    ? financial.marketplace_revenue
    : null;

const orderRaw = order?.raw_json && typeof order.raw_json === "object" ? order.raw_json : null;
const extListing = item.external_listing_id != null ? String(item.external_listing_id).trim() : "";
const extItem = item.external_order_item_id != null ? String(item.external_order_item_id).trim() : "";
const orderLine0 = Array.isArray(orderRaw?.order_items) ? orderRaw.order_items[0] : null;
const orderLineMatch = findMercadoLivreOrderLine(orderRaw, extItem || null, extListing || null);

const promoDirect = resolveSaleAppliedPromotion(item, order);

const out = {
  item_id: item.id,
  external_order_id: order?.external_order_id ?? item.external_order_id,
  external_listing_id: item.external_listing_id,
  "financial_breakdown.marketplace_revenue.applied_sale_promotion": mr?.applied_sale_promotion ?? null,
  applied_sale_promotion: financial.applied_sale_promotion ?? null,
  "financial_breakdown.marketplace_revenue.gross_sale_amount_brl": mr?.gross_sale_amount_brl ?? null,
  "financial_breakdown.gross_amount": financial.gross_amount ?? null,
  "raw_json.order_items[0].gross_price": orderLine0?.gross_price ?? null,
  "raw_json.order_items[matched].gross_price": orderLineMatch?.gross_price ?? null,
  "raw_json.order_items[matched].full_unit_price": orderLineMatch?.full_unit_price ?? null,
  "raw_json.order_items[matched].base_unit_price": orderLineMatch?.base_unit_price ?? null,
  "raw_json.order_items[matched].unit_price": orderLineMatch?.unit_price ?? null,
  "raw_json._s7_financial.discounts_snapshot": orderRaw?._s7_financial?.discounts_snapshot ?? null,
  resolveSaleAppliedPromotion_direct: promoDirect,
};

console.log(JSON.stringify(out, null, 2));
