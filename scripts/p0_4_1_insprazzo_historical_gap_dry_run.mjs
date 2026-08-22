#!/usr/bin/env node
/**
 * P0.4.1 — Insprazzo exact historical gap set (read-only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  resolveMlOrdersSearchSort,
  searchSellerOrdersPage,
  fetchOrderById,
} from "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js";

const INSPRAZZO = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const GAP_FROM = "2025-12-23T20:54:01.392Z";
const GAP_TO = "2026-02-21T20:54:01.392Z";
const W4 = { from: "2025-12-23T20:54:01.392Z", to: "2026-01-22T20:54:01.392Z" };
const W3 = { from: "2026-01-22T20:54:01.392Z", to: "2026-02-21T20:54:01.392Z" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(p) {
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

const env = {
  ...parseEnvFile(path.join(root, ".env.local")),
  ...parseEnvFile(path.join(root, ".env.vercel")),
  ...process.env,
};
for (const [k, v] of Object.entries(env)) {
  if (v != null && String(v).trim() !== "") process.env[k] = String(v);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function mlOrderIds(token, sellerId, from, to) {
  const ids = new Set();
  let offset = 0;
  for (let page = 0; page < 40; page += 1) {
    const pg = await searchSellerOrdersPage(token, sellerId, offset, 50, {
      dateFrom: from,
      dateTo: to,
      marketplaceAccountId: INSPRAZZO,
      sort: resolveMlOrdersSearchSort(),
    });
    for (const id of pg.orderIds ?? []) ids.add(String(id));
    if ((pg.orderIds?.length ?? 0) < 50) break;
    offset += 50;
  }
  return ids;
}

async function dbOrderIds(from, to) {
  const { data } = await sb
    .from("sales_orders")
    .select("external_order_id")
    .eq("marketplace_account_id", INSPRAZZO)
    .gte("date_created_marketplace", from)
    .lt("date_created_marketplace", to);
  return new Set((data ?? []).map((r) => String(r.external_order_id)).filter(Boolean));
}

const { data: acc } = await sb
  .from("marketplace_accounts")
  .select("id,user_id,external_seller_id,ml_nickname,seller_company_id")
  .eq("id", INSPRAZZO)
  .maybeSingle();
if (!acc) {
  console.error(JSON.stringify({ ok: false, error: "account_not_found" }));
  process.exit(2);
}

const { count: salesBefore } = await sb
  .from("sales_orders")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", INSPRAZZO);

const token = await getValidMLToken(acc.user_id, { marketplaceAccountId: INSPRAZZO });
const sellerId = String(acc.external_seller_id);

const [mlFull, dbFull, mlW4, dbW4, mlW3, dbW3] = await Promise.all([
  mlOrderIds(token, sellerId, GAP_FROM, GAP_TO),
  dbOrderIds(GAP_FROM, GAP_TO),
  mlOrderIds(token, sellerId, W4.from, W4.to),
  dbOrderIds(W4.from, W4.to),
  mlOrderIds(token, sellerId, W3.from, W3.to),
  dbOrderIds(W3.from, W3.to),
]);

const missing = [...mlFull].filter((id) => !dbFull.has(id)).sort();
const sample = [];
for (const id of missing.slice(0, 15)) {
  try {
    const detail = await fetchOrderById(token, id, { marketplaceAccountId: INSPRAZZO });
    sample.push({
      external_order_id: id,
      date_created: detail?.date_created ?? null,
      status: detail?.status ?? null,
      pack_id: detail?.pack_id ?? null,
    });
  } catch (e) {
    sample.push({ external_order_id: id, error: e?.message ? String(e.message).slice(0, 120) : String(e) });
  }
}

const report = {
  generated_at: new Date().toISOString(),
  mission: "P0.4.1_INSPRAZZO_EXACT_GAP",
  account: { id: INSPRAZZO, ml_nickname: acc.ml_nickname },
  sales_total_before: salesBefore ?? 0,
  full_gap_range: { from: GAP_FROM, to: GAP_TO, ml_count: mlFull.size, db_count: dbFull.size, missing_count: missing.length },
  w4: { ...W4, ml_count: mlW4.size, db_count: dbW4.size, missing_count: [...mlW4].filter((id) => !dbW4.has(id)).length },
  w3: { ...W3, ml_count: mlW3.size, db_count: dbW3.size, missing_count: [...mlW3].filter((id) => !dbW3.has(id)).length },
  union_check: {
    w3_plus_w4_ml: mlW3.size + mlW4.size,
    note: "missing set is computed on full range union, not assumed 39+57=102",
  },
  missing_order_ids: missing,
  missing_sample: sample,
  earliest_missing: sample[0]?.date_created ?? null,
  latest_missing: sample.length ? sample[sample.length - 1]?.date_created ?? null : null,
};

const outPath = path.join(root, "scripts/output/P0_4_1_INSPRAZZO_GAP_DRY_RUN.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, outPath, missing_count: missing.length, w4_missing: report.w4.missing_count, w3_missing: report.w3.missing_count }, null, 2));
