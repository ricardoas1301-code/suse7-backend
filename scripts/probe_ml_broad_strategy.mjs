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
const { scoreCandidateRelevance } = await import("../src/domain/competition/strategies/mlCompetitorRelevance.js");

const strategy = new MercadoLivreSearchCompetitionStrategy();

for (const [q, offset] of [
  ["tabua de passar", 0],
  ["tabua de passar", 20],
  ["cuba sobrepor polipropileno", 0],
]) {
  const debug = { attempts: [], search_queries_attempted: [] };
  const results = await strategy.discover({
    accessToken: tok,
    limit: 20,
    query: q,
    catalogOffset: offset,
    broadSearch: true,
    searchOnly: true,
    debug,
  });
  console.log(`\nq="${q}" offset=${offset} → ${results.length} candidatos, hasMore=${debug.paging?.hasMore}`);
  if (results[0]) {
    console.log("  top:", results[0].competitor_title?.slice(0, 70), "score=", scoreCandidateRelevance(q, results[0]));
  }
  if (results[1]) {
    console.log("  #2:", results[1].competitor_title?.slice(0, 70), "score=", scoreCandidateRelevance(q, results[1]));
  }
}
