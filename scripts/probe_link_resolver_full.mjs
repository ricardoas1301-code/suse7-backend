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

const { resolveCompetitorFromMercadoLivreLink } = await import("../src/domain/competition/competitionLinkResolver.js");
const { parseMercadoLivreListingUrl } = await import("../src/domain/competition/mlListingUrlParser.js");

const urls = [
  "https://produto.mercadolivre.com.br/MLB-5550559084-titulo-exemplo",
  "https://www.mercadolivre.com.br/cuba-banheiro/p/MLB53547043",
  "https://m.mercadolivre.com.br/cuba/p/MLB53547043",
  "MLB5550559084",
];

for (const url of urls) {
  const p = parseMercadoLivreListingUrl(url);
  const debug = {};
  const r = await resolveCompetitorFromMercadoLivreLink({ accessToken: tok, url, context: {}, debug });
  console.log("\n---");
  console.log("url:", url.slice(0, 75));
  console.log("parse:", p.ok ? `${p.id} type=${p.idType}` : p.code);
  console.log("resolve:", r.ok ? `OK ${r.candidate?.competitor_listing_id} via=${r.resolved_via} partial=${r.partial}` : `FAIL ${r.code}`);
  if (r.candidate) console.log(" title:", (r.candidate.competitor_title || "(null)").slice(0, 60));
  console.log(" attempts:", debug.attempts?.map((a) => `${a.endpoint || a.fallback}:${a.status ?? "-"}`).join(" | "));
}
