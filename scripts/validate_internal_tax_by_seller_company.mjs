#!/usr/bin/env node
/**
 * Valida imposto interno por CNPJ/empresa no Raio-X (sale detail).
 *
 * Uso: node scripts/validate_internal_tax_by_seller_company.mjs [external_order_id]
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildSaleDetailFinancialBreakdown } from "../src/handlers/sales/saleDetailFinancial.js";
import { resolveSaleInternalTaxProfile } from "../src/domain/sales/saleDetailInternalCosts.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const COMPANIES = [
  { label: "RF Móveis", cnpj: "62194333000156", expectRate: "1" },
  { label: "SMR Goiânia", cnpj: "73151110000209", expectRate: null },
  { label: "Inspirazzo", cnpj: "32064508000140", expectRate: null },
];

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function normCnpj(v) {
  return String(v ?? "").replace(/\D/g, "");
}

async function loadCompanyByCnpj(userId, cnpj) {
  const { data: rows } = await supabase
    .from("seller_companies")
    .select("id,company_name,trade_name,document_cnpj,default_tax_rate")
    .eq("user_id", userId);
  return (rows ?? []).find((r) => normCnpj(r.document_cnpj) === cnpj) ?? null;
}

async function sampleSaleForCompany(userId, companyId) {
  const { data: accounts } = await supabase
    .from("marketplace_accounts")
    .select("id,account_alias,ml_nickname,seller_company_id")
    .eq("user_id", userId)
    .eq("seller_company_id", companyId)
    .limit(5);
  const accountIds = (accounts ?? []).map((a) => a.id).filter(Boolean);
  if (accountIds.length === 0) return { account: null, item: null, order: null };

  const { data: items } = await supabase
    .from("sales_order_items")
    .select("id,quantity,product_id,marketplace_account_id,seller_company_id,raw_json,gross_amount")
    .eq("user_id", userId)
    .in("marketplace_account_id", accountIds)
    .order("created_at", { ascending: false })
    .limit(1);
  const item = items?.[0];
  if (!item) return { account: accounts?.[0] ?? null, item: null, order: null };

  const { data: order } = await supabase
    .from("sales_orders")
    .select("id,seller_company_id,marketplace_account_id,external_order_id")
    .eq("id", item.sales_order_id)
    .maybeSingle();

  return { account: accounts?.[0] ?? null, item, order };
}

async function main() {
  const filterOrder = process.argv.find((a) => /^\d{10,}$/.test(a));

  const { data: anyItem } = await supabase
    .from("sales_order_items")
    .select("user_id")
    .limit(1)
    .maybeSingle();
  const userId = anyItem?.user_id;
  if (!userId) {
    console.error("Nenhum item no banco para resolver user_id");
    process.exit(1);
  }

  console.log("[S7 INTERNAL TAX BY CNPJ] user_id=", userId, "\n");

  for (const spec of COMPANIES) {
    const company = await loadCompanyByCnpj(userId, spec.cnpj);
    if (!company) {
      console.log("—", spec.label, "CNPJ", spec.cnpj, "não encontrado no DEV");
      continue;
    }

    const { account, item, order } = await sampleSaleForCompany(userId, company.id);
    if (!item) {
      console.log("—", spec.label, "sem venda recente na conta marketplace");
      continue;
    }

    const { data: product } = item.product_id
      ? await supabase
          .from("products")
          .select("id,cost_price,packaging_cost,operational_cost")
          .eq("id", item.product_id)
          .maybeSingle()
      : { data: null };

    const taxProfile = await resolveSaleInternalTaxProfile(supabase, userId, {
      seller_company_id: order?.seller_company_id ?? item.seller_company_id ?? company.id,
      marketplace_account_id: item.marketplace_account_id,
    });

    const fin = buildSaleDetailFinancialBreakdown(item, product, order, null, {
      tax_percent: taxProfile.tax_percent,
      tax_percent_source: taxProfile.source,
      seller_company_id: taxProfile.seller_company_id,
      marketplace_account_id: taxProfile.marketplace_account_id,
    });

    const ic = fin.internal_costs;
    const rateOk =
      spec.expectRate == null
        ? ic.internal_tax_brl == null && ic.tax_percent_applied == null
        : ic.tax_percent_applied === spec.expectRate ||
          Number(ic.tax_percent_applied) === Number(spec.expectRate);

    console.log(spec.label, {
      company_id: company.id,
      cnpj: company.document_cnpj,
      default_tax_rate_db: company.default_tax_rate,
      marketplace_account: account?.account_alias ?? account?.ml_nickname ?? item.marketplace_account_id,
      external_order_id: order?.external_order_id ?? null,
      internal_costs: ic,
      status: rateOk ? "OK" : "CHECK",
    });
  }

  if (filterOrder) {
    const { data: ord } = await supabase
      .from("sales_orders")
      .select("id,user_id,seller_company_id,marketplace_account_id,external_order_id")
      .eq("external_order_id", filterOrder)
      .maybeSingle();
    const { data: item } = await supabase
      .from("sales_order_items")
      .select("*")
      .eq("sales_order_id", ord?.id)
      .limit(1)
      .maybeSingle();
    if (ord && item) {
      const taxProfile = await resolveSaleInternalTaxProfile(supabase, ord.user_id, {
        seller_company_id: ord.seller_company_id ?? item.seller_company_id,
        marketplace_account_id: item.marketplace_account_id ?? ord.marketplace_account_id,
      });
      const { data: product } = item.product_id
        ? await supabase.from("products").select("id,cost_price,packaging_cost,operational_cost").eq("id", item.product_id).maybeSingle()
        : { data: null };
      const fin = buildSaleDetailFinancialBreakdown(item, product, ord, null, {
        tax_percent: taxProfile.tax_percent,
        tax_percent_source: taxProfile.source,
        seller_company_id: taxProfile.seller_company_id,
        marketplace_account_id: taxProfile.marketplace_account_id,
      });
      console.log("\nPedido", filterOrder, "internal_costs:", fin.internal_costs);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
