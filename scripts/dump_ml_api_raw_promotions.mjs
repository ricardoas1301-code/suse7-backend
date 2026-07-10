#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
const { createClient } = require("@supabase/supabase-js");

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
  ...parseDotEnv(path.join(backendRoot, ".env.local")),
  ...process.env,
};
for (const [k, v] of Object.entries(env)) {
  if (v && !process.env[k]) process.env[k] = v;
}

import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import { extractSellerPromotionRowsFromItemPromotionsJson } from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";

const LISTING = process.argv[2] ?? "MLB4578041035";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: listing } = await sb
  .from("marketplace_listings")
  .select("user_id,marketplace_account_id")
  .eq("external_listing_id", LISTING)
  .maybeSingle();

const token = await getValidMLToken(String(listing.user_id), {
  marketplaceAccountId: listing.marketplace_account_id,
});

const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(LISTING)}?app_version=v2&limit=50&offset=0`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const json = await res.json();
console.log("HTTP", res.status);
console.log("TOP KEYS", json && typeof json === "object" ? Object.keys(json) : null);
const parsed = extractSellerPromotionRowsFromItemPromotionsJson(json);
console.log("EXTRACTED", parsed.rows.length);
for (const row of parsed.rows) {
  console.log(JSON.stringify({ id: row.id, name: row.name, type: row.type, sub_type: row.sub_type, status: row.status, price: row.price, ref_id: row.ref_id }));
}
const blob = JSON.stringify(json);
console.log("CONTAINS Impulsione?", blob.toLowerCase().includes("impulsione"));
if (blob.toLowerCase().includes("impulsione")) {
  const idx = blob.toLowerCase().indexOf("impulsione");
  console.log("SNIPPET", blob.slice(Math.max(0, idx - 120), idx + 200));
}
