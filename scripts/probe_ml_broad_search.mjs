// Probe: busca ampla — products/search paginado vs sites/search vs domain
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

async function get(path) {
  const r = await fetch(`https://api.mercadolibre.com${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}

const q = "tabua de passar";
console.log("=== sites/MLB/search ===");
for (const off of [0, 20, 40]) {
  const { status, j } = await get(`/sites/MLB/search?q=${encodeURIComponent(q)}&limit=20&offset=${off}`);
  const results = j?.results || [];
  console.log(`offset=${off} status=${status} results=${results.length} paging=${JSON.stringify(j?.paging || {})}`);
  if (results[0]) console.log("  sample id:", results[0].id, "title:", (results[0].title || "").slice(0, 60));
}

console.log("\n=== products/search paginado ===");
let totalItems = 0;
for (const off of [0, 20, 40, 60, 80]) {
  const { status, j } = await get(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}&limit=20&offset=${off}`);
  const products = j?.results || [];
  let pageItems = 0;
  for (const p of products.slice(0, 3)) {
    const it = await get(`/products/${p.id}/items?limit=10`);
    pageItems += (it.j?.results || []).length;
  }
  totalItems += pageItems;
  console.log(`offset=${off} status=${status} products=${products.length} items_sample=${pageItems} paging=${JSON.stringify(j?.paging || {})}`);
}

console.log("\n=== domain_discovery/search ===");
const dd = await get(`/sites/MLB/domain_discovery/search?q=${encodeURIComponent(q)}&limit=5`);
console.log("status=", dd.status, "results=", (dd.j || []).length || dd.j?.length);
