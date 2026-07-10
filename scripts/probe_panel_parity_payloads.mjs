#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
const { createClient } = require("@supabase/supabase-js");

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
  ...parseDotEnv(path.join(backendRoot, ".env.local")),
  ...process.env,
};
for (const [key, value] of Object.entries(env)) {
  if (value != null && String(value).trim() !== "" && process.env[key] == null) {
    process.env[key] = String(value);
  }
}

import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  fetchSellerPromotionsByItemDetailed,
  fetchSellerPromotionItemsForListing,
} from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { enrichOfficialSellerPromotionRowsFromApi } from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";

const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ["MLB6784329822", "MLB6086986228"];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

for (const ext of TARGETS) {
  const { data: listing } = await sb
    .from("marketplace_listings")
    .select("user_id,marketplace_account_id")
    .eq("external_listing_id", ext)
    .maybeSingle();
  if (!listing) {
    console.log("NOT FOUND", ext);
    continue;
  }
  const token = await getValidMLToken(String(listing.user_id), {
    marketplaceAccountId: listing.marketplace_account_id ?? undefined,
  });
  let { rows } = await fetchSellerPromotionsByItemDetailed(token, ext);
  if (rows.length > 0) {
    rows = await enrichOfficialSellerPromotionRowsFromApi(
      token,
      ext,
      rows,
      fetchSellerPromotionItemsForListing
    );
  }
  console.log("\n===", ext, "promos", rows.length, "===");
  for (const r of rows) {
    const name = r.name ?? r.promotion_name ?? r.type;
    console.log("---", name, "---");
    console.log(
      JSON.stringify(
        {
          id: r.id,
          type: r.type,
          status: r.status,
          original_price: r.original_price,
          price: r.price,
          suggested_discounted_price: r.suggested_discounted_price,
          max_discounted_price: r.max_discounted_price,
          min_discounted_price: r.min_discounted_price,
          seller_percentage: r.seller_percentage,
          meli_percentage: r.meli_percentage,
          discount_percentage: r.discount_percentage,
          discount_amount: r.discount_amount,
          _suse7_price_enriched: r._suse7_price_enriched,
          relevant_keys: Object.keys(r)
            .filter((k) => /price|disc|percent|amount|fee|receive|boost|seller|meli/i.test(k))
            .sort(),
        },
        null,
        2
      )
    );
  }
}
