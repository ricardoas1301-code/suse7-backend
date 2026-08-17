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

const tok = await fetch("https://api.mercadolibre.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
  }),
}).then((r) => r.json()).then((j) => j.access_token);

const catalogId = process.argv[2] || "MLB53547043";
const items = await fetch(`https://api.mercadolibre.com/products/${catalogId}/items?limit=3`, {
  headers: { Authorization: `Bearer ${tok}` },
}).then((r) => r.json());
const row = items?.results?.[0];
if (!row) {
  console.log("no items");
  process.exit(0);
}
const listingId = row.item_id;
const permalink = `https://www.mercadolivre.com.br/p/${catalogId}`;
console.log("catalog", catalogId, "item", listingId, "price", row.price);

const { enrichCompetitorListing } = await import("../src/domain/competition/competitionListingEnricher.js");
const r = await enrichCompetitorListing(tok, { listingId, permalink, debug: {} });
console.log(JSON.stringify({
  via: r.via,
  imageSource: r.imageSource,
  priceSource: r.priceSource,
  title: r.raw?.competitor_title,
  price: r.raw?.competitor_price,
  thumb: r.raw?.competitor_thumbnail?.slice(0, 60),
  seller: r.raw?.competitor_store_name,
}, null, 2));
