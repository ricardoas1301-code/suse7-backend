#!/usr/bin/env node
/**
 * Backfill idempotente — destinatário padrão da empresa principal.
 * Uso local (service role):
 *   node scripts/backfill_primary_company_default_recipients.mjs
 *   node scripts/backfill_primary_company_default_recipients.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import { ensurePrimaryCompanyDefaultRecipient } from "../src/domain/notifications/central/recipients/primaryCompanyDefaultRecipientService.js";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: companies, error } = await supabase
  .from("seller_companies")
  .select("user_id, is_primary")
  .order("is_primary", { ascending: false });

if (error) {
  console.error("Erro ao listar empresas:", error.message);
  process.exit(1);
}

/** @type {Set<string>} */
const sellerIds = new Set();
for (const row of companies ?? []) {
  if (row.is_primary === true) {
    sellerIds.add(String(row.user_id));
  }
}

/** sellers com empresa mas sem flag is_primary — fallback: primeiro por user */
if (sellerIds.size === 0) {
  for (const row of companies ?? []) {
    sellerIds.add(String(row.user_id));
  }
}

let ensured = 0;
let skipped = 0;
let failed = 0;

for (const sellerId of sellerIds) {
  if (dryRun) {
    console.log(`[dry-run] ensure default recipient seller=${sellerId}`);
    continue;
  }
  try {
    const result = await ensurePrimaryCompanyDefaultRecipient(supabase, sellerId);
    if (result.ok && result.ensured) ensured += 1;
    else skipped += 1;
  } catch (err) {
    failed += 1;
    console.error(`seller=${sellerId} error=${err?.message}`);
  }
}

console.log(
  JSON.stringify(
    {
      dry_run: dryRun,
      sellers_seen: sellerIds.size,
      ensured,
      skipped,
      failed,
    },
    null,
    2
  )
);

if (failed > 0) process.exit(1);
