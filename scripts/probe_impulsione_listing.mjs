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
import { fetchSellerPromotionItemsForListing } from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";

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

try {
  const items = await fetchSellerPromotionItemsForListing(
    token,
    "P-MLB17625058",
    "SMART",
    LISTING
  );
  console.log(JSON.stringify(items, null, 2));
} catch (err) {
  console.error(String(err?.message ?? err));
}
