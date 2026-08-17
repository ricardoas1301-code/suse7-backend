// Simula cadeia corrigida: products/search → items rows direto (sem multiget obrigatório)
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

async function itemsSafe(pid) {
  const r = await fetch(`https://api.mercadolibre.com/products/${pid}/items?limit=10`, { headers: { Authorization: `Bearer ${tok}` } });
  const j = await r.json().catch(() => null);
  return { status: r.status, results: Array.isArray(j?.results) ? j.results : [] };
}

for (const q of ["pia banheiro", "cuba banheiro", "escorredor"]) {
  const s = await fetch(`https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}&limit=5`, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
  const products = s.results || [];
  let candidates = [];
  for (const p of products.slice(0, 4)) {
    const it = await itemsSafe(p.id);
    for (const row of it.results) {
      if (row.item_id) candidates.push({ item_id: row.item_id, price: row.price, seller_id: row.seller_id, product: p.id, items_status: it.status });
    }
  }
  console.log(`q="${q}" products=${products.length} candidates=${candidates.length}`);
  if (candidates[0]) console.log("  sample:", candidates[0]);
}
