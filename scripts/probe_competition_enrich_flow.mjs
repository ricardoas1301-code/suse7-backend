import fs from "node:fs";
import path from "node:path";

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
for (const f of [".env.local", ".env"]) loadEnv(path.join(process.cwd(), f));

const listingId = process.argv[2] || "MLB5550559084";
const permalink =
  process.argv[3] || `https://produto.mercadolivre.com.br/MLB-5550559084-mesa-passadeira-teste`;

const tok = await fetch("https://api.mercadolibre.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
  }),
}).then((r) => r.json()).then((j) => j.access_token);

const { enrichCompetitorListing } = await import("../src/domain/competition/competitionListingEnricher.js");

const debug = {};
const r = await enrichCompetitorListing(tok, { listingId, permalink, debug });
console.log(JSON.stringify({
  listing_id: listingId,
  via: r.via,
  enrichSource: r.enrichSource,
  imageSource: r.imageSource,
  priceSource: r.priceSource,
  sellerSource: r.sellerSource,
  fields_found: r.fieldsFound,
  fields_missing: r.fieldsMissing,
  raw: {
    title: r.raw?.competitor_title ?? null,
    price: r.raw?.competitor_price ?? null,
    thumbnail: r.raw?.competitor_thumbnail ? String(r.raw.competitor_thumbnail).slice(0, 80) : null,
    seller_id: r.raw?.competitor_seller_id ?? null,
    store: r.raw?.competitor_store_name ?? null,
    listing_type: r.raw?.listing_type ?? null,
    free_shipping: r.raw?.shipping?.free_shipping ?? null,
  },
  attempts: debug.attempts?.length ?? 0,
}, null, 2));
