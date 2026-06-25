#!/usr/bin/env node
/**
 * GET /api/sales/detail no backend em execução (localhost ou Vercel DEV).
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const API_BASE = (process.env.S7_API_BASE || "http://localhost:3001").replace(/\/+$/, "");
const ITEM_IDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["7b66d21e-68bc-4d48-a2df-ec9b5daa72c2", "af8267d2-8f5c-491c-8470-2e344f2fcfb1"];

const url = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function getAccessTokenForItem(itemId) {
  const { data: item, error } = await supabase
    .from("sales_order_items")
    .select("user_id")
    .eq("id", itemId)
    .maybeSingle();
  if (error || !item?.user_id) throw new Error(`item ${itemId} not found`);

  const { data: userRow, error: userErr } = await supabase.auth.admin.getUserById(String(item.user_id));
  if (userErr || !userRow?.user?.email) throw userErr ?? new Error("user email not found");

  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY obrigatório para OTP");

  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: userRow.user.email,
  });
  if (linkErr) throw linkErr;

  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "email",
      token: link.properties.email_otp,
      email: userRow.user.email,
    }),
  });
  const verifyJson = await verifyRes.json();
  const token = verifyJson?.access_token;
  if (!token) throw new Error(`verify failed status=${verifyRes.status}`);
  return token;
}

async function fetchDetail(itemId) {
  const token = await getAccessTokenForItem(itemId);
  const detailUrl = `${API_BASE}/api/sales/detail?item_id=${encodeURIComponent(itemId)}`;
  const res = await fetch(detailUrl, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  const fin = body?.blocks?.financial_breakdown;
  const ic = fin?.internal_costs;
  const mr =
    fin?.marketplace_revenue && typeof fin.marketplace_revenue === "object"
      ? fin.marketplace_revenue
      : null;
  return {
    api_base: API_BASE,
    item_id: itemId,
    http_status: res.status,
    ok: body?.ok,
    external_order_id: body?.blocks?.general?.external_order_id,
    gross_sale_amount_brl: mr?.gross_sale_amount_brl ?? fin?.gross_amount ?? fin?.sale_price ?? null,
    applied_sale_promotion: mr?.applied_sale_promotion ?? fin?.applied_sale_promotion ?? null,
    profit_brl: body?.blocks?.profit_margin?.profit_brl ?? fin?.profit_brl,
    internal_costs: ic ?? null,
    internal_tax_flat: {
      internal_taxes: fin?.internal_taxes,
      internal_tax_amount: fin?.internal_tax_amount,
    },
    error: body?.error,
  };
}

async function main() {
  console.log(`[S7] HTTP sales/detail → ${API_BASE}\n`);
  for (const id of ITEM_IDS) {
    try {
      const r = await fetchDetail(id);
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.error(id, e instanceof Error ? e.message : e);
    }
    console.log("");
  }
}

main();
