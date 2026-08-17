#!/usr/bin/env node
/**
 * Simula GET /api/sales/detail → financial_breakdown (mesmo pipeline do handler).
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildSaleDetailFinancialBreakdown } from "../src/handlers/sales/saleDetailFinancial.js";
import { resolveSaleInternalTaxProfile } from "../src/domain/sales/saleDetailInternalCosts.js";
import { buildVendasUiRowsFromOrderItems } from "../src/handlers/sales/list.js";
import { attachSaleDetailPricingVariables } from "../src/handlers/sales/saleDetailPricingVariables.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const ORDERS = ["2000016513544546", "2000016523593692"];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function simulateDetail(userId, externalOrderId) {
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
  if (!ord || !item) return { error: "not found" };

  const [row] = await buildVendasUiRowsFromOrderItems(supabase, userId, [item]);
  const { data: product } = row?.product_id
    ? await supabase
        .from("products")
        .select("id,cost_price,packaging_cost,operational_cost")
        .eq("id", row.product_id)
        .maybeSingle()
    : { data: null };

  const sellerCompanyId = ord.seller_company_id ?? item.seller_company_id ?? null;
  const marketplaceAccountId = item.marketplace_account_id ?? ord.marketplace_account_id ?? null;

  const taxProfile = await resolveSaleInternalTaxProfile(supabase, userId, {
    seller_company_id: sellerCompanyId,
    marketplace_account_id: marketplaceAccountId,
  });

  let financial = buildSaleDetailFinancialBreakdown(item, product, ord, null, {
    tax_percent: taxProfile.tax_percent,
    tax_percent_source: taxProfile.source,
    seller_company_id: taxProfile.seller_company_id,
    marketplace_account_id: taxProfile.marketplace_account_id,
  });

  const financialAfterPricing = await attachSaleDetailPricingVariables(
    supabase,
    userId,
    null,
    item,
    ord,
    financial,
    row,
  );

  return {
    item_id: item.id,
    external_order_id: externalOrderId,
    order_seller_company_id: ord.seller_company_id,
    item_seller_company_id: item.seller_company_id,
    marketplace_account_id: marketplaceAccountId,
    taxProfile,
    financial_breakdown_keys: Object.keys(financialAfterPricing),
    internal_costs: financialAfterPricing.internal_costs ?? null,
    internal_tax_flat: {
      internal_taxes: financialAfterPricing.internal_taxes,
      internal_tax_amount: financialAfterPricing.internal_tax_amount,
      taxes: financialAfterPricing.taxes,
    },
    profit_brl: financialAfterPricing.profit_brl,
    gross: financialAfterPricing.gross_amount,
  };
}

async function main() {
  const { data: any } = await supabase.from("sales_order_items").select("user_id").limit(1).maybeSingle();
  const userId = any.user_id;

  console.log("Backend code path simulation (current repo)\n");
  for (const oid of ORDERS) {
    const r = await simulateDetail(userId, oid);
    console.log("---", oid, "---");
    console.log(JSON.stringify(r, null, 2));
  }
}

main();
