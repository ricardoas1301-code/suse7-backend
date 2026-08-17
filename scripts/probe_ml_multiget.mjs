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
const id = "MLB5550559084";
const mg = await fetch(`https://api.mercadolibre.com/items?ids=${id}`, { headers: { Authorization: `Bearer ${tok}` } });
console.log("multiget status", mg.status, JSON.stringify(await mg.json()).slice(0, 400));
const one = await fetch(`https://api.mercadolibre.com/items/${id}`, { headers: { Authorization: `Bearer ${tok}` } });
console.log("single status", one.status, JSON.stringify(await one.json()).slice(0, 400));
