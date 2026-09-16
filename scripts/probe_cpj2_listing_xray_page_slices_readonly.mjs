#!/usr/bin/env node
/**
 * CPJ2 Lote 6 — prova read-only: page 1 vs page 2 do anúncio (ORDER_ITEM).
 * DATABASE_MUTATION=0
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { expandExactExternalListingIds } from "../src/domain/sales/resolverFiltroExatoListingIdLista.js";

const LISTING_IDS = (process.env.OPEN_LISTING_IDS || "4222475231,6086562408").split(",").map((s) => s.trim()).filter(Boolean);
const T11_ENV = "C:\\ProjetosDev\\_rc-worktrees\\backend-cpj2-t1-reconnect-cta\\.env.local";

function parseDotEnv(filePath) {
  const out = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[line.slice(0, idx).trim()] = val;
  }
  return out;
}

function pageSlice(rows, page, pageSize = 100) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize;
  return rows.slice(from, to);
}

const env = parseDotEnv(T11_ENV);
const supabase = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const reports = [];
for (const listingId of LISTING_IDS) {
  const exactIds = expandExactExternalListingIds(listingId);
  const { data: listingMeta, error: listingErr } = await supabase
    .from("marketplace_listings")
    .select("user_id,external_listing_id,marketplace,marketplace_account_id")
    .in("external_listing_id", exactIds)
    .limit(5);
  if (listingErr) throw listingErr;
  const userId = listingMeta?.[0]?.user_id != null ? String(listingMeta[0].user_id) : "";
  if (!userId) {
    reports.push({ OPEN_LISTING_ID: listingId, exactIds, error: "listing_not_found" });
    continue;
  }
  const { data, error } = await supabase
    .from("sales_order_items")
    .select("id,sales_order_id,external_listing_id,created_at")
    .eq("user_id", userId)
    .in("external_listing_id", exactIds)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(8000);
  if (error) throw error;
  const rows = data || [];
  const p1 = pageSlice(rows, 1);
  const p2 = pageSlice(rows, 2);
  reports.push({
    OPEN_LISTING_ID: listingId,
    USER_ID: userId,
    MARKETPLACE: listingMeta?.[0]?.marketplace ?? null,
    MARKETPLACE_ACCOUNT_SCOPE: listingMeta?.[0]?.marketplace_account_id ?? null,
    exactIds,
    LIFETIME_ORDER_ITEM_ROWS: rows.length,
    EXPECTED_TOTAL_PAGES: Math.max(1, Math.ceil(rows.length / 100)),
    PAGE_1_RANGE: "0..99",
    PAGE_2_RANGE: "100..199",
    PAGE_1_ROWS: p1.length,
    PAGE_2_ROWS: p2.length,
    PAGE_1_FIRST_ORDER_ITEM_ID: p1[0]?.id ?? null,
    PAGE_1_LAST_ORDER_ITEM_ID: p1[p1.length - 1]?.id ?? null,
    PAGE_2_FIRST_ORDER_ITEM_ID: p2[0]?.id ?? null,
    PAGE_2_LAST_ORDER_ITEM_ID: p2[p2.length - 1]?.id ?? null,
    PAGE_1_FIRST_EQ_PAGE_2_FIRST: (p1[0]?.id ?? null) === (p2[0]?.id ?? null),
    CONTENT_TRANSITION: p1.length === 0 || p2.length === 0 ? "N_A" : p1[0]?.id !== p2[0]?.id ? "PASS" : "FAIL",
  });
}

process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
