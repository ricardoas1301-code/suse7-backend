#!/usr/bin/env node
/**
 * Aceite rápido — S1.PROMO-RESOLVER-PANEL-PARITY (listings homologação)
 */
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
import {
  fetchSellerPromotionsByItemDetailed,
  fetchSellerPromotionItemsForListing,
} from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  buildPromotionCardContract,
  enrichOfficialSellerPromotionRowsFromApi,
} from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";

const ACEITE = {
  MLB6784329822: {
    "07.07 e Descontaço": { final: "64.01", disc: "10.98", pct: "15" },
    "07.07 e Descontaco": { final: "64.01", disc: "10.98", pct: "15" },
    "Top Oferta Construcao": { final: "53.29", disc: "21.70", pct: "29" },
    "Top Oferta Construção": { final: "53.29", disc: "21.70", pct: "29" },
    "Aumente suas vendas": { final: "56.00", disc: "18.99", pct: "25" },
    "Liquida Full - Outlet": { final: "56.00", disc: "18.99", pct: "26" },
    "Oferta relâmpago": { final: "52.75", disc: "22.24", pct: "30" },
    "Oferta relampago": { final: "52.75", disc: "22.24", pct: "30" },
    LIGHTNING: { final: "52.75", disc: "22.24", pct: "30" },
  },
  MLB6086986228: {
    "Festival Casa Nova": { final: "261.80", disc: "8.10", pct: "3" },
    "7/7 SUPER Oferta CASA": { final: "215.92", disc: "53.98", pct: "20" },
    "SUPER Oferta CASA": { final: "215.92", disc: "53.98", pct: "20" },
    "Aumente suas vendas": { final: "231.00", disc: "38.90", pct: "14" },
    "Venda Casa e Decor": { final: "231.00", disc: "38.90", pct: "14" },
    "07.07 e Descontaço": { final: "261.80", disc: "8.10", pct: "4" },
    "07.07 e Descontaco": { final: "261.80", disc: "8.10", pct: "4" },
    "Liquida Full - Outlet": { final: "231.00", disc: "38.90", pct: "15" },
  },
  MLB6086602390: {
    "Liquida Full - Outlet": { final: "231.00", disc: "48.90", pct: "18" },
  },
  MLB4684020397: {
    "Aumente suas vendas": { final: "54.50", disc: "20.40", pct: "27" },
    "Top Oferta Construcao": { final: "54.50", disc: "20.40", pct: "27" },
    "Top Oferta Construção": { final: "54.50", disc: "20.40", pct: "27" },
    "07.07 e Descontaço": { final: "54.84", disc: "20.06", pct: "27" },
    "07.07 e Descontaco": { final: "54.84", disc: "20.06", pct: "27" },
    "Oferta relâmpago": { final: "53.17", disc: "21.73", pct: "30" },
    "Oferta relampago": { final: "53.17", disc: "21.73", pct: "30" },
    LIGHTNING: { final: "53.17", disc: "21.73", pct: "30" },
    "Liquida Full - Outlet": { final: "71.15", disc: "3.75", pct: "5" },
  },
  MLB5742272490: {
    "Liquida Full - Outlet": { final: "321.67", disc: "16.93", pct: "5" },
    "Aumente suas vendas": { final: "295.60", disc: "43.00", pct: "12.7" },
    "Festival Casa Nova": { final: "295.60", disc: "43.00", pct: "13" },
    "7/7 SUPER Oferta CASA": { final: "270.88", disc: "67.72", pct: "20" },
    "07.07 e Descontaco": { final: "295.60", disc: "43.00", pct: "13" },
    "07.07 e Descontaço": { final: "295.60", disc: "43.00", pct: "13" },
    "Venda Casa e Decor": { final: "295.60", disc: "43.00", pct: "13" },
  },
  MLB3303235755: {
    "Liquida Full - Outlet": { final: "167.18", disc: "18.96", pct: "11" },
  },
};

function matchAceite(listingId, name, type) {
  const map = ACEITE[listingId];
  if (!map) return null;
  const n = String(name ?? "").trim().toLowerCase();
  const typeNorm = type != null ? String(type).trim().toUpperCase() : "";
  if (typeNorm === "LIGHTNING" && map.LIGHTNING) return map.LIGHTNING;
  for (const [key, val] of Object.entries(map)) {
    if (key === "LIGHTNING") continue;
    if (n.includes(key.toLowerCase())) return val;
  }
  return null;
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

for (const listingId of Object.keys(ACEITE)) {
  console.log(`\n=== PANEL PARITY ${listingId} ===`);
  const { data: listing } = await sb
    .from("marketplace_listings")
    .select("user_id,marketplace_account_id")
    .eq("external_listing_id", listingId)
    .maybeSingle();
  if (!listing) {
    console.log("listing not found");
    continue;
  }
  const token = await getValidMLToken(String(listing.user_id), {
    marketplaceAccountId: listing.marketplace_account_id,
  });
  let { rows } = await fetchSellerPromotionsByItemDetailed(token, listingId);
  rows = await enrichOfficialSellerPromotionRowsFromApi(
    token,
    listingId,
    rows,
    fetchSellerPromotionItemsForListing
  );
  const cards = rows.map((row) =>
    buildPromotionCardContract({
      listingExternalId: listingId,
      promotionRow: row,
      sameListingPromotionRows: rows,
      liveFetchOk: true,
      promotionPayloadSource: "live",
      payloadLiveReceivedAt: new Date().toISOString(),
    })
  );
  for (const card of cards) {
    const aceite = matchAceite(listingId, card.promotion_name ?? "", card.promotion_type);
    if (!aceite) continue;
    const ok =
      card.real_promotion_final_price_brl === aceite.final &&
      card.discount_amount_brl === aceite.disc &&
      String(card.discount_percent_display) === aceite.pct;
    console.log(
      `[${ok ? "OK" : "FAIL"}] ${card.promotion_name}: ${card.real_promotion_final_price_brl}/${card.discount_amount_brl}/${card.discount_percent_display}% rule=${card.selected_rule}`
    );
  }
}
