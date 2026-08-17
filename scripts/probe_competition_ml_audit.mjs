// S7 — Auditoria de campos disponíveis para concorrentes ML (API oficial)
import fs from "node:fs";
import path from "node:path";

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
for (const f of [".env.local", ".env", ".env.vercel"]) loadEnv(path.join(process.cwd(), f));

const ML = "https://api.mercadolibre.com";

async function token() {
  const res = await fetch(`${ML}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
    }),
  });
  const j = await res.json();
  if (!j?.access_token) throw new Error("ML token unavailable (check ML_CLIENT_ID/SECRET in .env)");
  return j.access_token;
}

async function get(t, p) {
  const res = await fetch(`${ML}${p}`, { headers: { Authorization: `Bearer ${t}`, Accept: "application/json" } });
  const j = await res.json().catch(() => null);
  return { status: res.status, j };
}

function has(obj, key) {
  if (!obj || typeof obj !== "object") return false;
  const v = obj[key];
  return v != null && v !== "";
}

function auditRow(label, status, body, checks) {
  const row = { endpoint: label, http: status, available: {}, notes: [] };
  for (const [name, pathOrFn] of checks) {
    let ok = false;
    if (typeof pathOrFn === "function") ok = Boolean(pathOrFn(body));
    else if (Array.isArray(pathOrFn)) {
      let cur = body;
      for (const k of pathOrFn) cur = cur?.[k];
      ok = cur != null && cur !== "";
    } else ok = has(body, pathOrFn);
    row.available[name] = ok ? "sim" : status === 403 || status === 404 ? "bloqueado" : "nao";
  }
  return row;
}

const LISTING_ID = process.argv[2] || "MLB5550559084";
const CATALOG_ID = process.argv[3] || "MLB53547043";

(async () => {
  const t = await token();
  const rows = [];

  const item = await get(t, `/items/${LISTING_ID}`);
  rows.push(
    auditRow(`/items/{id}`, item.status, item.j, [
      ["title", "title"],
      ["price", "price"],
      ["thumbnail", (b) => b?.secure_thumbnail || b?.thumbnail || b?.pictures?.[0]?.secure_url],
      ["permalink", "permalink"],
      ["seller_id", "seller_id"],
      ["sold_quantity", "sold_quantity"],
      ["listing_type_id", "listing_type_id"],
      ["shipping", "shipping"],
      ["condition", "condition"],
      ["category_id", "category_id"],
      ["catalog_product_id", "catalog_product_id"],
      ["status", "status"],
      ["date_created", "date_created"],
      ["last_updated", "last_updated"],
    ])
  );

  const multiget = await get(t, `/items?ids=${LISTING_ID}`);
  const mgBody = Array.isArray(multiget.j) ? multiget.j[0]?.body : multiget.j;
  rows.push(
    auditRow(`/items?ids=`, multiget.status, mgBody, [
      ["title", "title"],
      ["price", "price"],
      ["thumbnail", (b) => b?.secure_thumbnail || b?.thumbnail],
      ["seller_id", "seller_id"],
      ["sold_quantity", "sold_quantity"],
    ])
  );

  const product = await get(t, `/products/${CATALOG_ID}`);
  rows.push(
    auditRow(`/products/{id}`, product.status, product.j, [
      ["name", "name"],
      ["pictures", (b) => Array.isArray(b?.pictures) && b.pictures.length > 0],
      ["permalink", "permalink"],
      ["buy_box_winner", "buy_box_winner"],
      ["attributes", (b) => Array.isArray(b?.attributes) && b.attributes.length > 0],
      ["date_created", "date_created"],
      ["last_updated", "last_updated"],
    ])
  );

  const pitems = await get(t, `/products/${CATALOG_ID}/items?limit=5`);
  const i0 = pitems.j?.results?.[0];
  rows.push(
    auditRow(`/products/{id}/items`, pitems.status, i0, [
      ["item_id", "item_id"],
      ["price", "price"],
      ["seller_id", "seller_id"],
      ["listing_type_id", "listing_type_id"],
      ["shipping", "shipping"],
      ["permalink", "permalink"],
      ["currency_id", "currency_id"],
    ])
  );

  const sellerId = i0?.seller_id || item.j?.seller_id;
  if (sellerId) {
    const user = await get(t, `/users/${sellerId}`);
    rows.push(
      auditRow(`/users/{seller_id}`, user.status, user.j, [
        ["nickname", "nickname"],
        ["seller_reputation.level_id", ["seller_reputation", "level_id"]],
        ["seller_reputation.power_seller_status", ["seller_reputation", "power_seller_status"]],
        ["address.city", ["address", "city"]],
        ["address.state", ["address", "state"]],
      ])
    );
  }

  console.log("[COMPETITION_AUDIT] listing_id", LISTING_ID, "catalog_id", CATALOG_ID);
  for (const r of rows) {
    console.log("\n---", r.endpoint, "HTTP", r.http, "---");
    for (const [k, v] of Object.entries(r.available)) console.log(`  ${k}: ${v}`);
  }

  console.log("\n[COMPETITION_AUDIT] summary_json");
  console.log(JSON.stringify(rows, null, 2));
})();
