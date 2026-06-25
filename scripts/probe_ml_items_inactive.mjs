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

for (const status of ["active", "inactive", ""]) {
  const url = `https://api.mercadolibre.com/products/search?site_id=MLB&q=${encodeURIComponent("cuba banheiro")}&limit=2${status ? "&status=" + status : ""}`;
  const s = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
  const p = s.results?.[0];
  if (!p) { console.log(`status=${status || "none"} no products`); continue; }
  const it = await fetch(`https://api.mercadolibre.com/products/${p.id}/items?limit=3`, { headers: { Authorization: `Bearer ${tok}` } });
  console.log(`status=${status || "none"} product=${p.id} items_http=${it.status}`);
}
