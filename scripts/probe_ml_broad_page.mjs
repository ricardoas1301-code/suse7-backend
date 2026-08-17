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
  return { status: r.status, j: await r.json().catch(() => null) };
}

async function collectPage(q, offset) {
  const { j } = await get(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}&limit=20&offset=${offset}`);
  const products = j?.results || [];
  const candidates = new Map();
  for (const p of products) {
    const it = await get(`/products/${p.id}/items?limit=20`);
    for (const row of it.j?.results || []) {
      if (row.item_id) candidates.set(row.item_id, { price: row.price, product: p.id, title: p.name });
    }
    if (!it.j?.results?.length) {
      const det = await get(`/products/${p.id}`);
      const bb = det.j?.buy_box_winner;
      if (bb?.item_id) candidates.set(bb.item_id, { price: bb.price, product: p.id, title: p.name, source: "bb" });
    }
  }
  return { products: products.length, candidates: candidates.size, paging: j?.paging };
}

for (const q of ["tabua de passar", "cuba sobrepor polipropileno"]) {
  console.log(`\n=== q="${q}" ===`);
  let acc = 0;
  for (const off of [0, 20, 40, 60, 80]) {
    const p = await collectPage(q, off);
    acc += p.candidates;
    console.log(`offset=${off} products=${p.products} new_candidates=${p.candidates} acc=${acc}`);
  }
}

// Test multiget on item ids from page 0
const page0 = await get(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent("tabua de passar")}&limit=20&offset=0`);
const ids = [];
for (const p of (page0.j?.results || []).slice(0, 5)) {
  const it = await get(`/products/${p.id}/items?limit=5`);
  for (const row of it.j?.results || []) if (row.item_id) ids.push(row.item_id);
}
if (ids.length) {
  const mg = await get(`/items?ids=${ids.slice(0, 3).join(",")}`);
  console.log("\nmultiget sample:", JSON.stringify(mg.j?.map?.((x) => ({ code: x.code, id: x.body?.id })) || mg.j));
}
