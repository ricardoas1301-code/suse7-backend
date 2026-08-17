// Testa MercadoLivreSearchCompetitionStrategy com token app (sem seller).
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
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.ML_CLIENT_ID, client_secret: process.env.ML_CLIENT_SECRET }),
}).then((r) => r.json()).then((j) => j.access_token);

const { MercadoLivreSearchCompetitionStrategy } = await import("../src/domain/competition/strategies/MercadoLivreSearchCompetitionStrategy.js");

const debug = {
  strategy_attempted: [],
  search_queries_attempted: [],
  attempts: [],
  productsCount: 0,
  productIds: [],
  itemIdsCount: 0,
  normalizedCount: 0,
  discardReasons: [],
};

const strategy = new MercadoLivreSearchCompetitionStrategy();
const results = await strategy.discover({
  accessToken: tok,
  limit: 10,
  query: "pia banheiro",
  product: { product_name: "Cuba De Banheiro" },
  listing: {},
  ownListingId: null,
  ownSellerId: null,
  debug,
});

console.log("results:", results.length);
console.log("sample:", results[0] ?? null);
console.log("debug:", JSON.stringify(debug, null, 2));
