#!/usr/bin/env node
/**
 * Validação final — bloco Resultado (lucro, margem, saúde) do Raio-x da venda.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Decimal from "decimal.js";
import { buildSaleDetailFinancialBreakdown } from "../src/handlers/sales/saleDetailFinancial.js";
import { resolveSaleInternalTaxProfile } from "../src/domain/sales/saleDetailInternalCosts.js";
import { buildVendasUiRowsFromOrderItems } from "../src/handlers/sales/list.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const CASES = [
  {
    name: "CHURRASCO SMR",
    external_order_id: "2000016521994192",
    expected: {
      net: "109.68",
      product: "66.14",
      tax: "13.82",
      op_pack: "1.16",
      profit: "28.56",
      margin: "18.60",
      margin_display: "18,6",
      health_label: "Ótimo",
      health_status: "healthy",
    },
  },
  {
    name: "RF Móveis",
    external_order_id: "2000016519990582",
    expected: {
      net: "151.85",
      product: "129.00",
      tax: "2.55",
      op_pack: "1.16",
      profit: "19.14",
      margin: "7.51",
      margin_display: "7,51",
      health_label: "Bom",
      health_status: "healthy",
    },
  },
  {
    name: "Inspirazzo",
    external_order_id: "2000016517460216",
    expected: {
      net: "49.47",
      product: "80.00",
      tax: "4.12",
      op_pack: "1.16",
      profit: "-35.81",
      margin: "-52.19",
      margin_display: "-52,19",
      health_label: "Crítico",
      health_status: "critical",
    },
  },
];

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function money(d) {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

async function buildForOrder(userId, externalOrderId) {
  const { data: ord } = await supabase
    .from("sales_orders")
    .select("*")
    .eq("external_order_id", externalOrderId)
    .maybeSingle();
  const { data: item } = await supabase
    .from("sales_order_items")
    .select("*")
    .eq("sales_order_id", ord?.id)
    .limit(1)
    .maybeSingle();
  if (!ord || !item) return { error: "not_found" };

  const [row] = await buildVendasUiRowsFromOrderItems(supabase, userId, [item]);
  const productId = row?.product_id ?? item.product_id;
  const { data: product } = productId
    ? await supabase
        .from("products")
        .select("id,cost_price,packaging_cost,operational_cost")
        .eq("user_id", userId)
        .eq("id", productId)
        .maybeSingle()
    : { data: null };

  const taxProfile = await resolveSaleInternalTaxProfile(supabase, userId, {
    seller_company_id: ord.seller_company_id ?? item.seller_company_id,
    marketplace_account_id: item.marketplace_account_id ?? ord.marketplace_account_id,
  });

  const fin = buildSaleDetailFinancialBreakdown(item, product, ord, null, {
    tax_percent: taxProfile.tax_percent,
    tax_percent_source: taxProfile.source,
    seller_company_id: taxProfile.seller_company_id,
    marketplace_account_id: taxProfile.marketplace_account_id,
  });

  const ic = fin.internal_costs ?? {};
  const net = fin.net_received_amount ?? fin.net_received;
  const gross = fin.gross_amount ?? fin.sale_price;

  const netD = new Decimal(String(net).replace(",", "."));
  const profitManual = netD
    .minus(ic.product_cost_brl ?? 0)
    .minus(ic.internal_tax_brl ?? 0)
    .minus(ic.operation_packaging_cost_brl ?? 0);

  const grossD = new Decimal(String(gross).replace(",", "."));
  const marginManual = grossD.isZero()
    ? null
    : profitManual.div(grossD).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

  return {
    external_order_id: externalOrderId,
    item_id: item.id,
    net_received: String(net),
    internal_costs: ic,
    profit_brl: fin.profit_brl,
    margin_percent: fin.margin_percent,
    health_label: fin.health_label,
    health_status: fin.health_status,
    profit_manual: money(profitManual),
    margin_manual: marginManual,
    result: fin.result,
  };
}

async function main() {
  const { data: any } = await supabase.from("sales_order_items").select("user_id").limit(1).maybeSingle();
  const userId = any.user_id;

  console.log("=== S7 RAYX — Validação bloco Resultado ===\n");
  console.log("Fórmulas:");
  console.log("  Lucro = net_received - product_cost - internal_tax - operation_packaging");
  console.log("  Margem = lucro / gross_sale_amount * 100 (Decimal, 2 casas HALF_UP)\n");

  const rows = [];
  for (const c of CASES) {
    const r = await buildForOrder(userId, c.external_order_id);
    if (r.error) {
      rows.push({ caso: c.name, pedido: c.external_order_id, status: "NOT_FOUND" });
      continue;
    }
    const e = c.expected;
    const profitOk = r.profit_brl === e.profit && r.profit_manual === e.profit;
    const marginOk = r.margin_percent === e.margin && r.margin_manual === e.margin;
    const healthLabelOk = r.health_label === e.health_label;
    const healthStatusOk = r.health_status === e.health_status;
    const netOk = r.net_received === e.net;
    const taxOk = r.internal_costs?.internal_tax_brl === e.tax;
    const allOk = profitOk && marginOk && healthLabelOk && healthStatusOk && netOk && taxOk;

    rows.push({
      caso: c.name,
      pedido: c.external_order_id,
      lucro: r.profit_brl,
      margem: r.margin_percent,
      saude: r.health_label,
      shell: r.health_status,
      status: allOk ? "BATE" : "DIVERGE",
      checks: { profitOk, marginOk, healthLabelOk, healthStatusOk, netOk, taxOk },
    });

    console.log(`--- ${c.name} (${c.external_order_id}) ---`);
    console.log(JSON.stringify(r, null, 2));
    console.log("expected", e);
    console.log(allOk ? "BATE\n" : "DIVERGE\n");
  }

  console.table(rows);
  if (!rows.every((r) => r.status === "BATE")) process.exit(1);
  console.log("\n3/3 casos do bloco Resultado batem com os prints.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
