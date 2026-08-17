#!/usr/bin/env node
// DASH.4C — validação scan completo vs baseline SQL (RF Móveis + Super Metalrio)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseDotEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = { ...parseDotEnv(path.join(root, ".env.vercel")), ...parseDotEnv(path.join(root, ".env.local")) };
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RF = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const SM = "7f351439-ea13-44de-8a9c-a2413713f6e4";

const mayPeriod = {
  preset: "custom",
  start_date: "2026-05-01",
  end_date: "2026-05-31",
  start_ms: Date.parse("2026-05-01T00:00:00.000Z"),
  end_ms_exclusive: Date.parse("2026-06-01T00:00:00.000Z"),
};

const EXCLUDED = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "invalid",
  "rejected",
  "payment_rejected",
  "payment_refunded",
  "charged_back",
]);

/**
 * @param {unknown} status
 */
function isEligibleStatus(status) {
  const s = status != null ? String(status).trim().toLowerCase() : "";
  return !s || !EXCLUDED.has(s);
}

/**
 * Baseline operacional via PostgREST (sem RPC) — pagina todos os itens do período.
 * @param {string} sellerId
 * @param {string | null} accountId
 */
async function sqlBaseline(sellerId, accountId) {
  const periodStart = new Date(mayPeriod.start_ms).toISOString();
  const periodEnd = new Date(mayPeriod.end_ms_exclusive).toISOString();

  /** @type {string[]} */
  const orderIds = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase
      .from("sales_orders")
      .select("id,order_status,order_substatus")
      .eq("user_id", sellerId)
      .gte("date_created_marketplace", periodStart)
      .lt("date_created_marketplace", periodEnd)
      .range(offset, offset + pageSize - 1);
    if (accountId) q = q.eq("marketplace_account_id", accountId);
    const { data, error } = await q;
    if (error) throw error;
    const page = data || [];
    for (const row of page) {
      const s = row.order_status != null ? String(row.order_status).trim().toLowerCase() : "";
      const sub = row.order_substatus != null ? String(row.order_substatus).trim().toLowerCase() : "";
      if (s && EXCLUDED.has(s)) continue;
      if (sub && EXCLUDED.has(sub)) continue;
      if (row?.id) orderIds.push(String(row.id));
    }
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  const uniqOrders = new Set(orderIds);
  let items = 0;
  let qty = 0;
  let gross = 0;
  let net = 0;
  let fee = 0;
  let shipping = 0;
  let tax = 0;

  const chunkSize = 100;
  const ids = [...uniqOrders];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let q = supabase
      .from("sales_order_items")
      .select("quantity,gross_amount,net_amount,fee_amount,shipping_share_amount,tax_amount")
      .eq("user_id", sellerId)
      .in("sales_order_id", chunk);
    if (accountId) q = q.eq("marketplace_account_id", accountId);
    const { data, error } = await q;
    if (error) throw error;
    for (const row of data || []) {
      items += 1;
      qty += Number(row.quantity ?? 0) || 0;
      gross += Number(row.gross_amount ?? 0) || 0;
      net += Number(row.net_amount ?? 0) || 0;
      if (row.fee_amount != null) fee += Number(row.fee_amount) || 0;
      if (row.shipping_share_amount != null) shipping += Number(row.shipping_share_amount) || 0;
      if (row.tax_amount != null) tax += Number(row.tax_amount) || 0;
    }
  }

  return {
    orders: uniqOrders.size,
    items,
    qty,
    gross: gross.toFixed(2),
    net: net.toFixed(2),
    fee: fee.toFixed(2),
    shipping: shipping.toFixed(2),
    tax: tax.toFixed(2),
  };
}

const { buildSaleExecutiveSummary } = await import("../src/domain/sales/buildSaleExecutiveSummary.js");

/**
 * @param {string} label
 * @param {string} sellerId
 * @param {string | null} accountId
 */
async function compareCase(label, sellerId, accountId) {
  const filters = { period: mayPeriod, marketplace_account_id: accountId };
  const t0 = Date.now();
  const summary = await buildSaleExecutiveSummary(supabase, sellerId, filters);
  const ms = Date.now() - t0;
  const base = await sqlBaseline(sellerId, accountId);

  const motor = {
    orders: summary.summary?.orders_count ?? 0,
    qty: summary.summary?.items_quantity_sold ?? 0,
    gross: String(summary.summary?.gross_sales_brl ?? "0"),
    net: String(summary.summary?.net_received_brl ?? "0"),
    fee: summary.summary?.marketplace_fee_brl != null ? String(summary.summary.marketplace_fee_brl) : null,
    shipping:
      summary.summary?.shipping_cost_brl != null ? String(summary.summary.shipping_cost_brl) : null,
    tax: summary.summary?.tax_cost_brl != null ? String(summary.summary.tax_cost_brl) : null,
    profit: String(summary.summary?.net_profit_brl ?? summary.summary?.contribution_profit_brl ?? "0"),
    margin: String(summary.summary?.contribution_margin_percent ?? "0"),
    truncated_scan: summary.truncated_scan,
  };

  const okOrders = motor.orders === base.orders;
  const okGross = motor.gross === base.gross;
  const okQty = motor.qty === base.qty;

  console.log(`\n=== ${label} ===`);
  console.log("SQL baseline:", base);
  console.log("Motor:       ", motor, `(ms=${ms}, truncated=${motor.truncated_scan})`);
  console.log(
    okOrders && okGross && okQty
      ? "RESULTADO: BATE (pedidos + faturamento + qty)"
      : `RESULTADO: DIVERGE orders=${okOrders} gross=${okGross} qty=${okQty}`,
  );
}

console.log("[DASH.4C] validação scan completo — maio/2026");

const { data: rfAccounts } = await supabase
  .from("marketplace_accounts")
  .select("id,ml_nickname,account_alias")
  .eq("user_id", RF);

await compareCase("RF Móveis — Todas as contas", RF, null);
for (const a of rfAccounts || []) {
  const name = a.ml_nickname || a.account_alias || a.id;
  await compareCase(`RF Móveis — ${name}`, RF, a.id);
}

await compareCase("Super Metalrio — Todas as contas", SM, null);
