import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { buildSaleDetailGeneralBlock } from "../src/domain/sales/saleDetailGeneral.js";
import { enrichMercadoLivreSaleTypeDisplay } from "../src/domain/sales/mercadoLivreSaleTypeDisplay.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";

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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: item } = await supabase
  .from("sales_order_items")
  .select("*, sales_orders!inner(*)")
  .eq("sales_orders.external_order_id", orderExt)
  .limit(1)
  .maybeSingle();

if (!item) {
  console.log("no item");
  process.exit(0);
}

const order = item.sales_orders;
const row = { ...item };
delete row.sales_orders;

const general = buildSaleDetailGeneralBlock(row, order, item);
console.log("sync", general.sale_type_display);

const token = await getValidMLToken(order.user_id, {
  marketplaceAccountId: order.marketplace_account_id,
});
const enriched = await enrichMercadoLivreSaleTypeDisplay(general, {
  order,
  item,
  row,
  accessToken: token,
  marketplaceAccountId: order.marketplace_account_id,
});
console.log("enriched", enriched.sale_type_display);
