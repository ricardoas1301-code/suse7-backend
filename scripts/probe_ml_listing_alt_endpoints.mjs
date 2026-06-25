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

const id = process.argv[2] || "MLB5550559084";
const tok = await fetch("https://api.mercadolibre.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
  }),
}).then((r) => r.json()).then((j) => j.access_token);

const h = { Authorization: `Bearer ${tok}`, Accept: "application/json" };
const paths = [
  `/items/${id}`,
  `/items?ids=${id}`,
  `/items/${id}/sale_price?context=channel_marketplace`,
  `/items/${id}/price_to_win?version=v2`,
  `/products/${id}`,
  `/items/${id}/catalog_product`,
  `/products/search?status=active&site_id=MLB&q=${encodeURIComponent(id)}&limit=5`,
  `/products/search?status=active&site_id=MLB&q=${encodeURIComponent("mesa passadeira")}&limit=3`,
];

for (const p of paths) {
  const res = await fetch(`https://api.mercadolibre.com${p}`, { headers: h });
  const j = await res.json().catch(() => null);
  const sample = Array.isArray(j) ? j[0] : j;
  console.log("\n", p, "->", res.status);
  if (Array.isArray(j) && j[0]) console.log(" multiget code:", j[0].code, "has_body:", Boolean(j[0].body));
  if (sample?.price != null) console.log(" price:", sample.price);
  if (sample?.title) console.log(" title:", String(sample.title).slice(0, 50));
  if (sample?.results?.length) console.log(" products:", sample.results.length, "first:", sample.results[0]?.id);
  if (sample?.message) console.log(" msg:", String(sample.message).slice(0, 80));
}

const mg = await fetch(`https://api.mercadolibre.com/items?ids=${id}`, { headers: h }).then((r) => r.json());
if (Array.isArray(mg) && mg[0]) {
  console.log("\n multiget entry:", JSON.stringify(mg[0], null, 2).slice(0, 1500));
}
const searchById = await fetch(`https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(id)}&limit=5`, { headers: h }).then((r) => r.json());
console.log("\n products/search by listing id:", searchById?.results?.map((p) => p.id));
if (searchById?.results?.[0]) {
  const pid = searchById.results[0].id;
  const items = await fetch(`https://api.mercadolibre.com/products/${pid}/items?limit=50`, { headers: h }).then((r) => r.json());
  const row = items?.results?.find((r) => String(r.item_id) === id);
  console.log(" first product items match:", row ? { price: row.price, seller: row.seller_id } : "no match in 50 rows");
}

for (const q of ["5550559084", "mesa passadeira dourada", "pia banheiro dourada", "mesa passadeira teste"]) {
  const s = await fetch(`https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}&limit=10`, { headers: h }).then((r) => r.json());
  const ids = (s.results || []).map((p) => p.id);
  console.log("\n q=", q, "->", ids.slice(0, 6), ids.includes("MLB53547043") ? "HAS_TARGET" : "");
}
