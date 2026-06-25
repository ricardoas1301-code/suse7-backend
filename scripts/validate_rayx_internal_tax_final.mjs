#!/usr/bin/env node
/**
 * Validação final — custos internos por CNPJ + regressão receita ML.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildSaleDetailFinancialBreakdown } from "../src/handlers/sales/saleDetailFinancial.js";
import { resolveSaleInternalTaxProfile } from "../src/domain/sales/saleDetailInternalCosts.js";
import { buildVendasUiRowsFromOrderItems } from "../src/handlers/sales/list.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const RF_ORDER = "2000016519990582";

/** @param {string} pattern */
async function findAccount(pattern) {
  const { data } = await supabase.from("marketplace_accounts").select("id,account_alias,ml_nickname,seller_company_id,user_id");
  return (data ?? []).filter((a) => {
    const n = `${a.account_alias ?? ""} ${a.ml_nickname ?? ""}`.toUpperCase();
    return n.includes(pattern.toUpperCase());
  });
}

/** @param {string} userId @param {string} accountId */
async function latestSaleForAccount(userId, accountId) {
  const { data: items } = await supabase
    .from("sales_order_items")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace_account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1);
  const item = items?.[0];
  if (!item) return null;
  const { data: order } = await supabase
    .from("sales_orders")
    .select("*")
    .eq("id", item.sales_order_id)
    .maybeSingle();
  return { item, order };
}

async function buildFinancialLikeDetail(userId, item, order) {
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
    seller_company_id: order?.seller_company_id ?? item.seller_company_id,
    marketplace_account_id: item.marketplace_account_id ?? order?.marketplace_account_id,
  });

  const fin = buildSaleDetailFinancialBreakdown(item, product, order, null, {
    tax_percent: taxProfile.tax_percent,
    tax_percent_source: taxProfile.source,
    seller_company_id: taxProfile.seller_company_id,
    marketplace_account_id: taxProfile.marketplace_account_id,
  });

  return { row, product, taxProfile, fin };
}

function normCnpj(v) {
  return String(v ?? "").replace(/\D/g, "");
}

async function companyForId(userId, id) {
  const { data } = await supabase
    .from("seller_companies")
    .select("id,company_name,trade_name,document_cnpj,default_tax_rate")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  return data;
}

async function validateRf(userId) {
  const { data: ord } = await supabase
    .from("sales_orders")
    .select("*")
    .eq("external_order_id", RF_ORDER)
    .maybeSingle();
  const { data: item } = await supabase
    .from("sales_order_items")
    .select("*")
    .eq("sales_order_id", ord?.id)
    .limit(1)
    .maybeSingle();
  if (!ord || !item) return { ok: false, error: "pedido não encontrado" };

  const { row, fin, taxProfile } = await buildFinancialLikeDetail(userId, item, ord);
  const ic = fin.internal_costs;
  const company = taxProfile.seller_company_id
    ? await companyForId(userId, taxProfile.seller_company_id)
    : null;
  const { data: acc } = await supabase
    .from("marketplace_accounts")
    .select("account_alias,ml_nickname")
    .eq("id", ic.marketplace_account_id)
    .maybeSingle();

  const checks = {
    conta: (acc?.account_alias ?? acc?.ml_nickname ?? "").toUpperCase().includes("LOJASRF"),
    tax_255: ic.internal_tax_brl === "2.55",
    tax_pct: ic.tax_percent_applied === "1.00",
    product_129: ic.product_cost_brl === "129.00",
    op_pack: ic.operation_packaging_cost_brl === "1.16",
    source: ic.source?.internal_tax === "seller_company_tax_profile",
    confidence: ic.confidence === "persisted",
    cnpj_rf: normCnpj(company?.document_cnpj) === "62194333000156",
  };

  return {
    ok: Object.values(checks).every(Boolean),
    external_order_id: RF_ORDER,
    account: acc?.account_alias ?? acc?.ml_nickname,
    company: company?.trade_name ?? company?.company_name,
    cnpj: company?.document_cnpj,
    internal_costs: ic,
    marketplace_revenue: {
      gross: fin.gross_amount,
      fee: fin.marketplace_fee_amount,
      shipping: fin.shipping_cost_amount,
      net: fin.net_received_amount,
    },
    checks,
    row_product_id: row?.product_id,
  };
}

async function validateAccountPattern(userId, pattern, expectMissingTax) {
  const accounts = await findAccount(pattern);
  if (accounts.length === 0) return { ok: false, error: `conta ${pattern} não encontrada` };
  const acc = accounts[0];
  const sale = await latestSaleForAccount(userId, acc.id);
  if (!sale) return { ok: false, error: `sem venda para ${pattern}`, account: acc };

  const { fin, taxProfile } = await buildFinancialLikeDetail(userId, sale.item, sale.order);
  const ic = fin.internal_costs;
  const company = taxProfile.seller_company_id
    ? await companyForId(userId, taxProfile.seller_company_id)
    : null;

  const checks = expectMissingTax
    ? {
        tax_null: ic.internal_tax_brl == null,
        pct_null: ic.tax_percent_applied == null,
        source: ic.source?.internal_tax === "missing_tax_profile",
        no_profile_fallback: taxProfile.source !== "profile_fallback",
        company_linked: Boolean(taxProfile.seller_company_id),
      }
    : {};

  return {
    ok: expectMissingTax ? Object.values(checks).every(Boolean) : true,
    pattern,
    external_order_id: sale.order?.external_order_id,
    account: acc.account_alias ?? acc.ml_nickname,
    company: company?.trade_name ?? company?.company_name,
    default_tax_rate: company?.default_tax_rate,
    taxProfile,
    internal_costs: ic,
    checks,
  };
}

async function main() {
  const { data: any } = await supabase.from("sales_order_items").select("user_id").limit(1).maybeSingle();
  const userId = any?.user_id;
  if (!userId) process.exit(1);

  console.log("=".repeat(72));
  console.log("[S7 RAYX FINAL] Validação custos internos por CNPJ — DEV");
  console.log("=".repeat(72));

  const rf = await validateRf(userId);
  console.log("\n--- MISSÃO 1: RF Móveis (2000016519990582) ---");
  console.log(JSON.stringify(rf, null, 2));

  const smr = await validateAccountPattern(userId, "CHURRASCO SMR", true);
  console.log("\n--- MISSÃO 2: SMR Goiânia (CHURRASCO SMR) ---");
  console.log(JSON.stringify(smr, null, 2));

  const insp = await validateAccountPattern(userId, "INSPIRAZZO", true);
  console.log("\n--- MISSÃO 3: Inspirazzo ---");
  console.log(JSON.stringify(insp, null, 2));

  console.log("\n--- RESUMO ---");
  console.table([
    { caso: "RF Móveis", pedido: RF_ORDER, status: rf.ok ? "BATE" : "DIVERGE" },
    { caso: "SMR", pedido: smr.external_order_id ?? "—", status: smr.ok ? "BATE" : "DIVERGE" },
    { caso: "Inspirazzo", pedido: insp.external_order_id ?? "—", status: insp.ok ? "BATE" : "DIVERGE" },
  ]);

  const allOk = rf.ok && smr.ok && insp.ok;
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
