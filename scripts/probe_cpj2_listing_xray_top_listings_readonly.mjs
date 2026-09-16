#!/usr/bin/env node
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";
const T11_ENV = "C:\\ProjetosDev\\_rc-worktrees\\backend-cpj2-t1-reconnect-cta\\.env.local";

function parseDotEnv(filePath) {
  const out = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[line.slice(0, idx).trim()] = val;
  }
  return out;
}

const env = parseDotEnv(T11_ENV);
const supabase = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: items, error } = await supabase
  .from("sales_order_items")
  .select("id,external_listing_id")
  .eq("user_id", USER_ID)
  .limit(8000);
if (error) throw error;

const by = new Map();
for (const r of items || []) {
  const ext = String(r.external_listing_id ?? "").trim();
  if (!ext) continue;
  by.set(ext, (by.get(ext) || 0) + 1);
}
const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

const inflation = [];
for (const [id, exact] of top) {
  const { count } = await supabase
    .from("sales_order_items")
    .select("id", { count: "exact", head: true })
    .eq("user_id", USER_ID)
    .or(
      [
        `title_snapshot.ilike.%${id}%`,
        `sku_snapshot.ilike.%${id}%`,
        `external_listing_id.ilike.%${id}%`,
        `external_order_item_id.ilike.%${id}%`,
        `external_order_id.ilike.%${id}%`,
      ].join(","),
    );
  inflation.push({ id, exact, ilike: count ?? 0, extra: Math.max(0, (count ?? 0) - exact) });
}

process.stdout.write(`${JSON.stringify({ top, inflation, gt100: top.filter((x) => x[1] > 100) }, null, 2)}\n`);
