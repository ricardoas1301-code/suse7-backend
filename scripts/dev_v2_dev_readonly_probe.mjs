#!/usr/bin/env node
/**
 * Read-only DEV checks for orphan tables + global reference counts.
 * NÃO escreve no DEV.
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { extractSupabaseProjectRef, S7_SUPABASE_PROJECT_REF } from "../src/billing/services/billingRuntimeEnvironmentService.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ref = extractSupabaseProjectRef(process.env);
if (ref === S7_SUPABASE_PROJECT_REF.PROD) process.exit(2);
if (!url || !key) process.exit(1);

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function tableCount(table) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  return error ? { count: null, error: error.message } : { count: count ?? 0 };
}

async function main() {
  const orphanTables = [
    "marketplace_account_sales_import_coverage",
    "billing_payment_methods",
    "legal_document_acceptances",
  ];
  const globalTables = ["plans", "notification_templates", "communication_templates", "notification_catalog_entries"];
  const runtimeTables = ["profiles", "seller_companies", "marketplace_accounts", "sales_orders", "ml_webhook_events"];

  const out = { project_ref: ref, orphan: {}, global: {}, runtime: {} };
  for (const t of orphanTables) out.orphan[t] = await tableCount(t);
  for (const t of globalTables) out.global[t] = await tableCount(t);
  for (const t of runtimeTables) out.runtime[t] = await tableCount(t);
  console.log(JSON.stringify(out, null, 2));
}

main();
