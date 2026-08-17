#!/usr/bin/env node
/**
 * Refresh financeiro Raio-x de uma venda pelo external_order_id ML.
 * Uso: node scripts/refresh_sale_by_external_order.mjs 2000016508408082
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { refreshSaleFinancialContractByItemId } from "../src/services/sales/saleFinancialContractRefresh.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const extOrder = process.argv[2]?.trim() || "2000016508408082";
const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function pickFin(raw) {
  const fin = raw?._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
}

async function main() {
  const { data: orders, error: oErr } = await supabase
    .from("sales_orders")
    .select("id,user_id,external_order_id,marketplace_account_id,raw_json")
    .eq("external_order_id", extOrder)
    .limit(10);
  if (oErr) throw oErr;

  if (!orders?.length) {
    console.error("Pedido não encontrado:", extOrder);
    process.exit(1);
  }

  for (const ord of orders) {
    const userId = String(ord.user_id);
    const { data: items, error: iErr } = await supabase
      .from("sales_order_items")
      .select("id,gross_amount,fee_amount,marketplace_account_id,raw_json")
      .eq("sales_order_id", ord.id);
    if (iErr) throw iErr;

    console.log("\n=== Pedido", ord.external_order_id, "| user", userId, "| items", items?.length ?? 0, "===\n");

    for (const item of items || []) {
      const before = pickFin(item.raw_json);
      console.log("BEFORE item", item.id, {
        gross: item.gross_amount,
        fee_amount: item.fee_amount,
        marketplace_fee: before?.marketplace_fee,
        listing_type_label: before?.listing_type_label,
      });

      let accessToken = null;
      const accountId = item.marketplace_account_id || ord.marketplace_account_id;
      if (accountId) {
        try {
          accessToken = await getValidMLToken(userId, { marketplaceAccountId: String(accountId) });
          console.log("ML token OK for account", accountId);
        } catch (e) {
          console.warn("ML token unavailable:", e instanceof Error ? e.message : e);
        }
      }

      const result = await refreshSaleFinancialContractByItemId(supabase, userId, String(item.id), { accessToken });
      console.log("REFRESH", result);

      const { data: after } = await supabase
        .from("sales_order_items")
        .select("gross_amount,fee_amount,raw_json")
        .eq("id", item.id)
        .single();
      const fin = pickFin(after?.raw_json);
      console.log("AFTER", {
        gross: after?.gross_amount,
        fee_amount: after?.fee_amount,
        marketplace_fee: fin?.marketplace_fee,
        listing_type_label: fin?.listing_type_label,
        net_received: fin?.net_received_amount_brl,
        shipping: fin?.shipping_amount_brl,
        positive_adjustments: fin?.positive_adjustments_brl,
        mode: result.mode,
      });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
