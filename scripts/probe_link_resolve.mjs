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

// item real vs product catálogo (pia banheiro probe anterior)
const itemId = "MLB5550559084";
const productId = "MLB53547043";

console.log("=== /items/{item} ===");
console.log(await get(`/items/${itemId}`).then((x) => ({ status: x.status, id: x.j?.id, err: x.j?.message || x.j?.error })));

console.log("=== /items/{product_id} (wrong) ===");
console.log(await get(`/items/${productId}`).then((x) => ({ status: x.status, err: x.j?.message || x.j?.error })));

console.log("=== /products/{product}/items ===");
console.log(await get(`/products/${productId}/items?limit=3`).then((x) => ({
  status: x.status,
  count: x.j?.results?.length,
  first: x.j?.results?.[0]?.item_id,
})));

console.log("=== /products/{item_id}/items (wrong) ===");
console.log(await get(`/products/${itemId}/items?limit=3`).then((x) => ({ status: x.status, count: x.j?.results?.length })));
