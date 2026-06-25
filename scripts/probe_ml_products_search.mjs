// Probe seguro: testa /products/search (catalog finder) do Mercado Livre.
// Usa client_credentials (token de app) só para diagnóstico. NUNCA imprime o token.
// Uso: node scripts/probe_ml_products_search.mjs
import fs from "node:fs";
import path from "node:path";

function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, "");
      if (!(key in process.env) || !process.env[key]) process.env[key] = val;
    }
  } catch {}
}

const root = path.resolve(process.cwd());
for (const f of [".env.local", ".env", ".env.vercel"]) loadEnv(path.join(root, f));

const clientId = process.env.ML_CLIENT_ID?.trim();
const clientSecret = process.env.ML_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("ML_CLIENT_ID/ML_CLIENT_SECRET ausentes no ambiente. Abortando.");
  process.exit(2);
}

async function getAppToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, token: json?.access_token || null, error: json?.error || json?.message || null };
}

async function productsSearch(token, q) {
  const url = `https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}&limit=5`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, endpoint: url.replace(/q=[^&]*/, "q=<q>") };
}

async function productItems(token, productId) {
  const url = `https://api.mercadolibre.com/products/${encodeURIComponent(productId)}/items?limit=5`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = await res.json().catch(() => null);
  return { status: res.status, count: Array.isArray(json?.results) ? json.results.length : 0 };
}

const terms = ["escorredor", "escorredor de louça", "escorredor para pia", "cuba banheiro", "kit placas mdf"];

(async () => {
  const tok = await getAppToken();
  console.log(`[token] grant=client_credentials status=${tok.status} got_token=${Boolean(tok.token)}${tok.error ? " error=" + tok.error : ""}`);
  if (!tok.token) {
    console.log("Sem token de app — client_credentials pode não estar habilitado para este app.");
    process.exit(0);
  }
  for (const q of terms) {
    const r = await productsSearch(tok.token, q);
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    console.log(`\n[products/search] q="${q}" status=${r.status} results=${results.length}`);
    if (results[0]) {
      console.log(`  → top: id=${results[0].id} name="${(results[0].name || "").slice(0, 60)}" domain=${results[0].domain_id || "?"}`);
      const it = await productItems(tok.token, results[0].id);
      console.log(`  → /products/${results[0].id}/items status=${it.status} items=${it.count}`);
    } else if (r.status !== 200) {
      console.log(`  ! body=${JSON.stringify(r.json).slice(0, 200)}`);
    }
  }
})();
