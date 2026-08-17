// Probe: cadeia products/search → product detail → items para "pia banheiro"
import fs from "node:fs";
import path from "node:path";
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
for (const f of [".env.local", ".env", ".env.vercel"]) loadEnv(path.join(process.cwd(), f));

async function token() {
  const res = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
    }),
  });
  return (await res.json())?.access_token;
}

async function get(t, path) {
  const res = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
  });
  const j = await res.json().catch(() => null);
  return { status: res.status, j };
}

function summarizeProduct(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: (p.name || "").slice(0, 50),
    keys: Object.keys(p).slice(0, 25),
    buy_box_winner: p.buy_box_winner,
    pickers_len: Array.isArray(p.pickers) ? p.pickers.length : 0,
    pickers_sample: Array.isArray(p.pickers) ? p.pickers.slice(0, 2) : null,
    children_ids: p.children_ids,
    pictures: Array.isArray(p.pictures) ? p.pictures.length : 0,
    main_features: p.main_features ? "yes" : "no",
  };
}

(async () => {
  const t = await token();
  for (const q of ["pia banheiro", "cuba banheiro"]) {
    console.log(`\n=== q="${q}" ===`);
    const s = await get(t, `/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}&limit=3`);
    const products = s.j?.results || [];
    console.log(`search status=${s.status} products=${products.length}`);
    for (const p of products.slice(0, 2)) {
      console.log(`\n  product ${p.id}: ${(p.name || "").slice(0, 55)}`);
      console.log(`  search_result_keys=${Object.keys(p).join(",")}`);
      const d = await get(t, `/products/${p.id}`);
      console.log(`  detail status=${d.status}`, JSON.stringify(summarizeProduct(d.j), null, 2));
      const it = await get(t, `/products/${p.id}/items?limit=5`);
      console.log(`  items status=${it.status} count=${Array.isArray(it.j?.results) ? it.j.results.length : 0}`);
      if (it.j?.results?.[0]) console.log(`  item0_keys=${Object.keys(it.j.results[0]).join(",")} sample=${JSON.stringify(it.j.results[0]).slice(0, 300)}`);
    }
  }
})();
