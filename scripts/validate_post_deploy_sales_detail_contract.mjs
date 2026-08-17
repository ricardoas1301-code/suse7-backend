#!/usr/bin/env node
/**
 * Valida contrato equivalente ao GET /api/sales/detail (financial_breakdown)
 * a partir do snapshot persistido em sales_order_items.raw_json._s7_financial.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildSaleDetailFinancialBreakdown } from "../src/handlers/sales/saleDetailFinancial.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const ORDERS = [
  { db: "2000016523593692", fee: "78.21", rebate: null, net: "397.14" },
  { db: "2000016522414612", fee: null, rebate: null, net: "271.48" },
  { db: "2000016521263060", fee: "17.44", rebate: "5.20", net: "76.39" },
  { db: "2000016517460216", fee: null, rebate: "2.12", net: "49.47" },
  { db: "2000016521985682", fee: null, rebate: null, net: "75.62" },
  { db: "2000016504327334", fee: null, rebate: null, net: "76.09" },
];

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function pickRebate(fin) {
  const r = fin?.marketplace_rebate;
  if (r && typeof r === "object" && r.confidence === "explicit" && r.amount_brl) return String(r.amount_brl);
  return fin?.positive_adjustments_brl != null ? String(fin.positive_adjustments_brl) : null;
}

async function main() {
  console.log("[S7 POST-DEPLOY] Validação contrato sales/detail (via snapshot persistido)\n");
  const rows = [];

  for (const exp of ORDERS) {
    const { data: ord } = await supabase
      .from("sales_orders")
      .select("id,raw_json")
      .eq("external_order_id", exp.db)
      .maybeSingle();
    const { data: item } = await supabase
      .from("sales_order_items")
      .select("id,quantity,raw_json,gross_amount,fee_amount,marketplace,tax_amount")
      .eq("sales_order_id", ord?.id)
      .maybeSingle();

    const snap = item?.raw_json?._s7_financial;
    const fin = buildSaleDetailFinancialBreakdown(
      { ...item, marketplace: item?.marketplace ?? "mercado_livre" },
      null,
      null,
      null,
    );
    const mr = fin.marketplace_revenue ?? {};

    const fee = fin.marketplace_fee_amount ?? mr.marketplace_fee_amount_brl ?? null;
    const rebate = pickRebate(mr) ?? pickRebate(snap);
    const net = fin.net_received_amount ?? fin.net_received ?? null;
    const snapVer = snap?.snapshot_version ?? null;

    const feeOk = exp.fee == null || fee === exp.fee;
    const rebateOk = exp.rebate == null ? rebate == null || rebate === "0.00" : rebate === exp.rebate;
    const netOk = net === exp.net;
    const status = feeOk && rebateOk && netOk ? "BATE" : "DIVERGE";

    rows.push({
      pedido: exp.db,
      tarifa: fee,
      rebate: rebate ?? "—",
      net,
      snapshot_version: snapVer,
      fee_source: mr._sources?.fee_gross ?? snap?.marketplace_fee?.raw_amount_source_path ?? null,
      status,
    });
  }

  console.table(rows);
  const allOk = rows.every((r) => r.status === "BATE");
  if (!allOk) process.exit(1);
  console.log("\n6/6 contratos alinhados com painel ML (leitura snapshot + buildSaleDetailFinancialBreakdown).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
