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

const q = "cuba sobrepor polipropileno";
const results = await new MercadoLivreSearchCompetitionStrategy().discover({
  accessToken: tok,
  limit: 50,
  query: q,
  catalogOffset: 0,
  broadSearch: true,
  debug: { attempts: [], search_queries_attempted: [] },
});

const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const pp = results.filter((r) => norm(r.competitor_title).includes("poliprop"));
const mar = results.filter((r) => norm(r.competitor_title).includes("marmore"));
console.log("total", results.length, "poliprop", pp.length, "marmore", mar.length);
for (const r of results.slice(0, 10)) {
  console.log(scoreCandidateRelevance(q, r), (r.competitor_title || "").slice(0, 70));
}
if (pp[0]) console.log("best pp score", scoreCandidateRelevance(q, pp[0]), pp[0].competitor_title);
