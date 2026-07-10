#!/usr/bin/env node
/**
 * S1.PROMO-SSOT-FRESHNESS-AUDIT — homologação ponta a ponta Modal PI
 * Uso: node suse7-backend/scripts/audit_pi_promotion_ssot_freshness.mjs [MLB...] [...]
 *
 * Responde por listing:
 * 1. PI usa live API ou DB snapshot?
 * 2. Dado está fresco?
 * 3. Contract backend bate com a fonte?
 * 4. Existe diferença live ML vs DB?
 * 5. Se divergir, qual camada?
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(backendRoot, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
const { createClient } = require("@supabase/supabase-js");

import { buildMercadoLivreListingPromotionsFreshnessDebug } from "../src/domain/pricing/mercadoLivrePromotionSsotFreshnessAudit.js";

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
  ...parseDotEnv(path.join(backendRoot, ".env.local")),
  ...process.env,
};

for (const [key, value] of Object.entries(env)) {
  if (value != null && String(value).trim() !== "" && process.env[key] == null) {
    process.env[key] = String(value).replace(/^["']|["']$/g, "");
  }
}

const SUPABASE_URL = env.SUPABASE_URL?.replace(/^["']|["']$/g, "") ?? process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  env.SUPABASE_SERVICE_ROLE_KEY?.replace(/^["']|["']$/g, "") ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

const TARGETS =
  process.argv.slice(2).filter(Boolean).length > 0
    ? process.argv.slice(2).filter(Boolean)
    : [
        "MLB6415546858",
        "MLB6487881250",
        "MLB6526137900",
        "MLB3734084847",
        "MLB6248404078",
        "MLB6784329822",
      ];

/** @param {Record<string, unknown>} report */
function printListingSummary(report) {
  const s = report.summary;
  if (!s || typeof s !== "object") return;
  const sum = /** @type {Record<string, unknown>} */ (s);
  console.log(`  Q1 PI fonte: ${sum.q1_pi_modal_source}`);
  console.log(`  Q2 Fresco: ${sum.q2_data_is_fresh === true ? "SIM" : "NAO"}`);
  console.log(`  Q3 Contract bate fonte: ${sum.q3_contract_matches_source === true ? "SIM" : "NAO"}`);
  console.log(`  Q4 Live != DB: ${sum.q4_live_differs_from_db === true ? "SIM" : "NAO"}`);
  console.log(`  Q5 Camada divergente: ${sum.q5_diverging_layer ?? "nenhuma"}`);
}

async function auditListing(sb, externalListingId) {
  const { data: listing, error: listingErr } = await sb
    .from("marketplace_listings")
    .select("id,user_id,external_listing_id,title,updated_at")
    .eq("external_listing_id", externalListingId)
    .maybeSingle();

  if (listingErr || !listing) {
    return { listing_id: externalListingId, error: listingErr?.message ?? "listing_not_found" };
  }

  const userId = String(listing.user_id);
  const report = await buildMercadoLivreListingPromotionsFreshnessDebug(sb, userId, {
    listingExternalId: externalListingId,
    forceFresh: true,
    referenceZipCode: env.SUSE7_ML_PRICING_REFERENCE_ZIP ?? "01310100",
  });

  if (!report.ok) {
    return { listing_id: externalListingId, error: report.error ?? "freshness_debug_failed" };
  }

  return {
    listing_id: externalListingId,
    listing_title: listing.title ?? null,
    listing_updated_at: listing.updated_at ?? null,
    ...report,
  };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (.env.local ou env).");
    process.exit(1);
  }

  process.env.S7_PROMOTIONS_PI_AUDIT = "1";

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const results = [];
  for (const id of TARGETS) {
    console.log(`\n=== S1.PROMO-SSOT-FRESHNESS-AUDIT: ${id} ===`);
    const report = await auditListing(sb, id);
    results.push(report);
    if (report.error) {
      console.error("ERRO:", report.error);
      continue;
    }
    printListingSummary(report);
    const audits = Array.isArray(report.freshness_audits) ? report.freshness_audits : [];
    for (const row of audits) {
      const warns = Array.isArray(row.warnings) && row.warnings.length > 0 ? row.warnings.join(",") : "-";
      console.log(
        `  [${row.pi_modal_uses}] ${row.promotion_name}: final=${row.ui_final_price} live=${row.live_ui_final_price ?? "n/a"} warns=${warns}`
      );
    }
  }

  const outDir = path.join(repoRoot, "scripts", "output");
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `AUDIT_PI_PROMOTION_SSOT_FRESHNESS_${stamp}.json`);
  await fs.writeFile(
    outFile,
    JSON.stringify({ generated_at: new Date().toISOString(), targets: TARGETS, results }, null, 2)
  );
  console.log(`\nRelatório: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
