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

async function items(pid) {
  const r = await fetch(`https://api.mercadolibre.com/products/${pid}/items?limit=3`, { headers: { Authorization: `Bearer ${tok}` } });
  const j = await r.json().catch(() => null);
  return { status: r.status, n: Array.isArray(j?.results) ? j.results.length : 0, first: j?.results?.[0]?.item_id };
}

const s = await fetch("https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=cuba%20banheiro&limit=3", { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
for (const p of s.results || []) {
  const a = await items(p.id);
  const b = p.catalog_product_id && p.catalog_product_id !== p.id ? await items(p.catalog_product_id) : null;
  console.log(`id=${p.id} cat=${p.catalog_product_id || "-"} items(id)=${a.status}/${a.n} ${a.first || ""} items(cat)=${b ? b.status + "/" + b.n : "skip"}`);
}
