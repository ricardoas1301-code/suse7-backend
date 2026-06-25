#!/usr/bin/env node
/**
 * BILLING 04.16 — consumo mensal com vendas reais em sales_order_items.
 * Uso: node scripts/validateBillingMonthlyUsageRealSales.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { resolveSellerBillingCycle } from "../src/billing/services/billingCycleService.js";
import {
  BILLING_USAGE_AGGREGATION_SCOPE,
  resolveMonthlySalesUsage,
} from "../src/billing/services/billingUsageService.js";

loadEnv({ path: ".env.local" });
loadEnv();

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl || !serviceKey) {
  console.error("Falta SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** @type {string[]} */
const results = [];

function pass(msg) {
  results.push(`PASS: ${msg}`);
  console.log(`PASS: ${msg}`);
}

function fail(msg, detail) {
  const line = detail ? `FAIL: ${msg} — ${detail}` : `FAIL: ${msg}`;
  results.push(line);
  console.error(line);
}

async function main() {
  console.log("=== S7 BILLING 04.16 — consumo mensal com vendas reais ===");

  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const userId = usersData?.users?.[0]?.id ? String(usersData.users[0].id) : null;
  const { data: plan } = await supabase
    .from("plans")
    .select("id, plan_key")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!userId || !plan?.id) {
    fail("fixture", "usuário/plano indisponível");
    process.exit(1);
  }

  const { cycle } = await resolveSellerBillingCycle(supabase, userId);
  const inWindow = `${cycle.period_start}T12:00:00.000Z`;
  const outWindow = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const insertedOrderIds = [];
  const insertedItemIds = [];

  const orderRows = [
    {
      user_id: userId,
      marketplace: "mercado_livre",
      external_order_id: `s7_usage_validate_${randomUUID()}`,
      date_created_marketplace: inWindow,
      total_amount: 10,
      api_imported_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      user_id: userId,
      marketplace: "mercado_livre",
      external_order_id: `s7_usage_validate_${randomUUID()}`,
      date_created_marketplace: outWindow,
      total_amount: 10,
      api_imported_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const { data: orders, error: orderError } = await supabase
    .from("sales_orders")
    .insert(orderRows)
    .select("id");
  if (orderError) {
    fail("fixture sales_orders", orderError.message);
    process.exit(1);
  }
  for (const row of orders ?? []) {
    if (row?.id) insertedOrderIds.push(String(row.id));
  }
  if (insertedOrderIds.length < 2) {
    fail("fixture sales_orders", "pedidos de teste não criados");
    process.exit(1);
  }

  const itemRows = [
    {
      user_id: userId,
      sales_order_id: insertedOrderIds[0],
      marketplace: "mercado_livre",
      external_order_id: orderRows[0].external_order_id,
      external_listing_id: `MLB${randomUUID().slice(0, 8)}`,
      quantity: 1,
      api_imported_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      user_id: userId,
      sales_order_id: insertedOrderIds[0],
      marketplace: "mercado_livre",
      external_order_id: orderRows[0].external_order_id,
      external_listing_id: `MLB${randomUUID().slice(0, 8)}`,
      quantity: 1,
      api_imported_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      user_id: userId,
      sales_order_id: insertedOrderIds[1],
      marketplace: "mercado_livre",
      external_order_id: orderRows[1].external_order_id,
      external_listing_id: `MLB${randomUUID().slice(0, 8)}`,
      quantity: 1,
      api_imported_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const { data: inserted, error: insertError } = await supabase
    .from("sales_order_items")
    .insert(itemRows)
    .select("id");
  if (insertError) {
    fail("fixture sales_order_items", insertError.message);
    process.exit(1);
  }
  for (const row of inserted ?? []) {
    if (row?.id) insertedItemIds.push(String(row.id));
  }

  try {
    const usageResult = await resolveMonthlySalesUsage(supabase, userId, String(plan.id), cycle);
    const total = Number(usageResult.usage?.total_sales_month ?? usageResult.current_month_sales ?? 0);
    if (total >= 2) pass("usage.total_sales_month considera vendas no ciclo atual");
    else fail("usage.total_sales_month", JSON.stringify({ total, cycle, usage: usageResult.usage }));

    if (usageResult.aggregation_scope === BILLING_USAGE_AGGREGATION_SCOPE) {
      pass("aggregation_scope = seller_ecosystem");
    } else {
      fail("aggregation_scope", String(usageResult.aggregation_scope));
    }

    const breakdownTotal = Object.values(usageResult.breakdowns?.marketplaces ?? {}).reduce(
      (sum, value) => sum + Number(value ?? 0),
      0
    );
    if (breakdownTotal >= 2) pass("breakdowns de marketplaces refletem vendas do ciclo");
    else fail("breakdowns marketplaces", JSON.stringify(usageResult.breakdowns));
  } finally {
    if (insertedItemIds.length > 0) {
      await supabase.from("sales_order_items").delete().in("id", insertedItemIds);
    }
    if (insertedOrderIds.length > 0) {
      await supabase.from("sales_orders").delete().in("id", insertedOrderIds);
    }
  }

  const failed = results.filter((line) => line.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
