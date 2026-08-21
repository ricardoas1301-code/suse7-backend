#!/usr/bin/env node
/** P0.3-C.1B — RF backfill execution (limitado, idempotente) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recoverSalesMissingManualReviewPending } from "../src/billing/services/billingManualReviewPendingReconcilerService.js";

const RF_ACCOUNT = "359327e4-9902-4213-a1c3-1de702ef92ee";
const WITNESS = "2000018031307152";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = { ...parseEnvFile(path.join(root, ".env.local")) };
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const execResult = await recoverSalesMissingManualReviewPending(sb, {
  marketplaceAccountId: RF_ACCOUNT,
  limit: 25,
  dryRun: false,
  snapshot_origin: "operational_sync",
});

const { count: witnessPending } = await sb
  .from("billing_billable_sale_admissions")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", RF_ACCOUNT)
  .eq("external_order_id", WITNESS)
  .eq("admission_result", "PENDING_MANUAL_REVIEW");

const { count: witnessReserved } = await sb
  .from("billing_billable_sale_admissions")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", RF_ACCOUNT)
  .eq("external_order_id", WITNESS)
  .in("admission_result", ["RESERVED", "PERSISTED"]);

const { count: witnessSales } = await sb
  .from("sales_orders")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", RF_ACCOUNT)
  .eq("external_order_id", WITNESS);

const out = {
  generated_at: new Date().toISOString(),
  rf_account_id: RF_ACCOUNT,
  witness: WITNESS,
  exec: execResult,
  witness_sales: witnessSales ?? 0,
  witness_pending: witnessPending ?? 0,
  witness_reserved: witnessReserved ?? 0,
};

const outPath = path.join(root, "scripts/output/P0_3C1B_RF_BACKFILL_EXEC.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
