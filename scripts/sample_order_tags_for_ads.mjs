import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";

function loadEnv() {
  for (const p of [".env.local", ".env"]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await supabase
  .from("sales_orders")
  .select("external_order_id,raw_json")
  .eq("marketplace", "mercado_livre")
  .order("date_created_marketplace", { ascending: false })
  .limit(200);

if (error) {
  console.error(error);
  process.exit(1);
}

/** @type {Map<string, number>} */
const tagCounts = new Map();
/** @type {string[]} */
const adLike = [];

for (const row of data || []) {
  const raw = row.raw_json;
  const tags = Array.isArray(raw?.tags) ? raw.tags.map(String) : [];
  for (const t of tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const blob = JSON.stringify(raw || {});
  if (/advertis|publicidade|product_ad|affiliat|afiliad/i.test(blob)) {
    adLike.push(`${row.external_order_id} tags=${tags.join(",")}`);
  }
}

console.log("tag counts (top 30):");
console.log(
  [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([t, c]) => `${t}: ${c}`)
    .join("\n"),
);
console.log("\nad-like blob matches:", adLike.length);
for (const s of adLike.slice(0, 15)) console.log(s);

const d2c = (data || []).filter((r) => Array.isArray(r.raw_json?.tags) && r.raw_json.tags.includes("d2c"));
console.log("\nd2c orders in sample:", d2c.length, "of", data?.length);
