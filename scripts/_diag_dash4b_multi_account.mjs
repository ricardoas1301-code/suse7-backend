#!/usr/bin/env node
// DASH.4B — diagnóstico escopo multi-contas (RF Móveis + Super Metalrio)
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

const { buildSaleExecutiveSummary } = await import("../src/domain/sales/buildSaleExecutiveSummary.js");
const { fetchExecutiveSummarySourceItems } = await import("../src/domain/sales/saleExecutiveSourceItems.js");

const mayPeriod = {
  preset: "custom",
  start_date: "2026-05-01",
  end_date: "2026-05-31",
  start_ms: Date.parse("2026-05-01T00:00:00.000Z"),
  end_ms_exclusive: Date.parse("2026-06-01T00:00:00.000Z"),
};

/**
 * @param {string} sellerLabel
 * @param {string} sellerId
 */
async function probeSeller(sellerLabel, sellerId) {
  console.log(`\n========== ${sellerLabel} (${sellerId}) ==========`);
  const { data: accounts, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id,ml_nickname,account_alias,status")
    .eq("user_id", sellerId);
  if (accErr) {
    console.error("accounts error:", accErr.message);
    return;
  }
  console.log(
    "Contas:",
    (accounts || []).map((a) => ({
      id: a.id,
      nick: a.ml_nickname,
      alias: a.account_alias,
      status: a.status,
    })),
  );

  /**
   * @param {string} label
   * @param {string | null} accountId
   */
  async function runCase(label, accountId) {
    const filters = { period: mayPeriod, marketplace_account_id: accountId };
    const t0 = Date.now();
    try {
      const items = await fetchExecutiveSummarySourceItems(supabase, sellerId, filters);
      const summary = await buildSaleExecutiveSummary(supabase, sellerId, filters);
      console.log(
        `  ${label} | items=${items.length} | orders=${summary.summary?.orders_count ?? 0} | gross=${summary.summary?.gross_sales_brl ?? "0"} | ms=${Date.now() - t0}`,
      );
    } catch (e) {
      console.log(`  ${label} | ERROR ${e?.message ?? e}`);
    }
  }

  await runCase("Todas as contas", null);
  for (const a of accounts || []) {
    const name = a.ml_nickname || a.account_alias || a.id;
    await runCase(`Conta ${name}`, a.id);
  }

  const { count: orderCountAll } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", sellerId)
    .gte("date_created_marketplace", mayPeriod.start_ms ? new Date(mayPeriod.start_ms).toISOString() : "")
    .lt("date_created_marketplace", mayPeriod.end_ms_exclusive ? new Date(mayPeriod.end_ms_exclusive).toISOString() : "");
  console.log(`  [ref] sales_orders no período (todas contas): ${orderCountAll ?? "?"}`);
}

await probeSeller("RF Móveis", RF);
await probeSeller("Super Metalrio", SM);
