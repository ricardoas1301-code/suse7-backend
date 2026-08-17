#!/usr/bin/env node
/**
 * Simula o clique do Modal Raio-X via HTTP local (mesmo path do browser).
 * node scripts/testSaleRayxModalHttpLocal.mjs [sale_id]
 */

import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv({ path: resolve(root, "../suse7-frontend/.env.development") });

const apiBase = (process.env.S7_API_BASE || "http://localhost:3001").replace(/\/+$/, "");
const smokeSeller = process.env.S7_PROVIDER_SMOKE_SELLER?.trim();
const smokePhone = String(process.env.S7_PROVIDER_SMOKE_PHONE ?? "5517991883100").replace(/\D/g, "");
const anonKey =
  process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim();

async function getJwt(sb, sbUrl, userId) {
  const { data: u } = await sb.auth.admin.getUserById(userId);
  const email = u?.user?.email;
  if (!email) throw new Error("sem email");
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const verifyRes = await fetch(`${sbUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "email", token: link.properties.email_otp, email }),
  });
  const json = await verifyRes.json();
  if (!json.access_token) throw new Error("verify failed");
  return json.access_token;
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  let saleId = process.argv[2]?.trim();
  if (!saleId) {
    const { data } = await sb
      .from("sales_order_items")
      .select("id")
      .eq("user_id", smokeSeller)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    saleId = data?.id;
  }

  const url = `${apiBase}/api/notifications/manual/sale-rayx`;
  console.log("POST", url);
  console.log("sale_id", saleId, "seller", smokeSeller, "phone", smokePhone);

  const jwt = await getJwt(sb, process.env.SUPABASE_URL, smokeSeller);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sale_id: saleId,
      channel: "whatsapp",
      recipient_phone: smokePhone,
    }),
  });
  const json = await res.json();
  console.log("\nHTTP", res.status);
  console.log(JSON.stringify(json, null, 2));

  const ok =
    json.real_send_executed === true &&
    json.backend_debug?.api_origin?.includes("localhost") &&
    json.outbox_status_after === "sent";
  process.exit(ok ? 0 : 5);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
