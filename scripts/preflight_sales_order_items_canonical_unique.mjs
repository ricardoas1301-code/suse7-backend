#!/usr/bin/env node
/**
 * Gate 1 preflight — conflitos na combinação UNIQUE de 4 colunas (read-only DEV).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { createClient } = require("@supabase/supabase-js");

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const env = parseDotEnv(path.join(root, ".env.local"));
const url = process.env.SUPABASE_URL || env.SUPABASE_URL || "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!url || !key) {
  console.error(JSON.stringify({ ok: false, error: "missing_supabase_credentials" }));
  process.exit(2);
}

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const PAGE = 1000;
/** @type {Record<string, unknown>[]} */
const rows = [];
let offset = 0;
while (true) {
  const { data, error } = await sb
    .from("sales_order_items")
    .select(
      "id, marketplace, marketplace_account_id, external_order_id, external_order_item_id, created_at",
    )
    .not("external_order_item_id", "is", null)
    .order("id", { ascending: true })
    .range(offset, offset + PAGE - 1);
  if (error) throw error;
  const page = data ?? [];
  rows.push(...page);
  if (page.length < PAGE) break;
  offset += PAGE;
}

/** @type {Map<string, Record<string, unknown>[]>} */
const groups = new Map();
for (const row of rows) {
  const key = [
    row.marketplace,
    row.marketplace_account_id,
    row.external_order_id,
    row.external_order_item_id,
  ]
    .map((v) => (v != null ? String(v).trim() : ""))
    .join("||");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const conflicts = [...groups.entries()]
  .filter(([, list]) => list.length > 1)
  .map(([key, list]) => ({
    conflict_key: key,
    count: list.length,
    item_ids: list.map((r) => r.id),
    external_order_id: list[0]?.external_order_id ?? null,
  }));

const result = {
  ok: conflicts.length === 0,
  gate: "GATE_1_UNIQUE_FOUR_COLUMNS_PREFLIGHT",
  rows_with_external_order_item_id: rows.length,
  distinct_four_column_keys: groups.size,
  conflict_groups: conflicts.length,
  conflicts_sample: conflicts.slice(0, 20),
  migration_safe: conflicts.length === 0,
};

console.log(JSON.stringify(result, null, 2));
process.exit(conflicts.length === 0 ? 0 : 1);
