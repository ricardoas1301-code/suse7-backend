#!/usr/bin/env node
/** P0.3-C.1B — RF backfill dry-run (operational sales sem admission) */
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

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...parseEnvFile(path.join(root, ".env.vercel")) };
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ ok: false, error: "missing_supabase_env" }));
  process.exit(2);
}

try {
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const result = await recoverSalesMissingManualReviewPending(sb, {
    marketplaceAccountId: RF_ACCOUNT,
    limit: 50,
    dryRun: true,
    snapshot_origin: "operational_sync",
  });

  const witnessInCandidates = (result.details ?? []).some(
    (d) => String(d.external_order_id) === WITNESS,
  );

  const out = {
    generated_at: new Date().toISOString(),
    rf_account_id: RF_ACCOUNT,
    witness: WITNESS,
    witness_in_candidates: witnessInCandidates,
    candidate_count: (result.details ?? []).filter((d) => d.dry_run).length,
    scanned: result.scanned,
    candidates: (result.details ?? []).filter((d) => d.dry_run),
    historical_safe: (result.details ?? []).length < 100,
  };

  const outPath = path.join(root, "scripts/output/P0_3C1B_RF_BACKFILL_DRY_RUN.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  if (!out.historical_safe) {
    console.error("STOP: unexpected candidate volume");
    process.exit(1);
  }
} catch (err) {
  console.error(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      details: err,
    }),
  );
  process.exit(1);
}
