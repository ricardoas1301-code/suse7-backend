#!/usr/bin/env node
/**
 * P0.4.1 — Insprazzo historical gap recovery (canonical motor, onboarding import).
 * Usage: node scripts/p0_4_1_insprazzo_historical_gap_recovery.mjs [--execute]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  resolveMlOrdersSearchSort,
  searchSellerOrdersPage,
  fetchOrderById,
} from "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { applyMlOrderDetailToMarketplaceSales } from "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";

const INSPRAZZO = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const GAP_FROM = "2025-12-23T20:54:01.392Z";
const GAP_TO = "2026-02-21T20:54:01.392Z";
const W3_EVIDENCE = "8f08e2c5-52ab-4e0d-b804-babf9feef6ef";
const W4_EVIDENCE = "acf757c5-ed89-432e-9f56-fb13e7cc8986";
const execute = process.argv.includes("--execute");

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

const env = {
  ...parseEnvFile(path.join(root, ".env.local")),
  ...parseEnvFile(path.join(root, ".env.vercel")),
  ...process.env,
};
for (const [k, v] of Object.entries(env)) {
  if (v != null && String(v).trim() !== "") process.env[k] = String(v);
}
// Recovery autorizado P0.4.1 — bypass temporário do kill switch de writers (somente neste script).
const prevMaintenanceMode = process.env.DEV_GLOBAL_MAINTENANCE_MODE;
process.env.DEV_GLOBAL_MAINTENANCE_MODE = "0";

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function mlOrderIds(token, sellerId, from, to) {
  const ids = new Set();
  let offset = 0;
  for (let page = 0; page < 40; page += 1) {
    const pg = await searchSellerOrdersPage(token, sellerId, offset, 50, {
      dateFrom: from,
      dateTo: to,
      marketplaceAccountId: INSPRAZZO,
      sort: resolveMlOrdersSearchSort(),
    });
    for (const id of pg.orderIds ?? []) ids.add(String(id));
    if ((pg.orderIds?.length ?? 0) < 50) break;
    offset += 50;
  }
  return ids;
}

async function dbOrderIdSet(from, to) {
  const { data } = await sb
    .from("sales_orders")
    .select("external_order_id")
    .eq("marketplace_account_id", INSPRAZZO)
    .gte("date_created_marketplace", from)
    .lt("date_created_marketplace", to);
  return new Set((data ?? []).map((r) => String(r.external_order_id)).filter(Boolean));
}

const dryPath = path.join(root, "scripts/output/P0_4_1_INSPRAZZO_GAP_DRY_RUN.json");
if (!fs.existsSync(dryPath)) {
  console.error(JSON.stringify({ ok: false, stop: "run_dry_run_first", dryPath }));
  process.exit(2);
}
const dry = JSON.parse(fs.readFileSync(dryPath, "utf8"));
const expectedMissing = dry.missing_count ?? dry.missing_order_ids?.length ?? 0;

const { data: acc } = await sb
  .from("marketplace_accounts")
  .select("id,user_id,external_seller_id,seller_company_id,ml_nickname")
  .eq("id", INSPRAZZO)
  .maybeSingle();
if (!acc) process.exit(2);

const { count: salesBefore } = await sb
  .from("sales_orders")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", INSPRAZZO);

const token = await getValidMLToken(acc.user_id, { marketplaceAccountId: INSPRAZZO });
const sellerId = String(acc.external_seller_id);
const mlIds = await mlOrderIds(token, sellerId, GAP_FROM, GAP_TO);
const dbIds = await dbOrderIdSet(GAP_FROM, GAP_TO);
const candidates = [...mlIds].filter((id) => !dbIds.has(id)).sort();

if (candidates.length !== expectedMissing) {
  console.error(
    JSON.stringify({
      ok: false,
      stop: "candidate_count_diverged_from_dry_run",
      dry_run: expectedMissing,
      live: candidates.length,
    }),
  );
  process.exit(3);
}

const recoveryJobs = [
  {
    user_id: acc.user_id,
    marketplace: "mercado_livre",
    marketplace_account_id: INSPRAZZO,
    seller_company_id: acc.seller_company_id,
    job_type: "ml_historical_sales_backfill",
    status: execute ? "running" : "pending",
    metadata: {
      recovery_kind: "p0_4_1_gap_recovery",
      recovery_evidence_job_id: W4_EVIDENCE,
      date_from: "2025-12-23T20:54:01.392Z",
      date_to: "2026-01-22T20:54:01.392Z",
      window_index: 904,
      window_label: "P0.4.1 recovery W4",
      phase: "historical_sales_window",
    },
  },
  {
    user_id: acc.user_id,
    marketplace: "mercado_livre",
    marketplace_account_id: INSPRAZZO,
    seller_company_id: acc.seller_company_id,
    job_type: "ml_historical_sales_backfill",
    status: execute ? "running" : "pending",
    metadata: {
      recovery_kind: "p0_4_1_gap_recovery",
      recovery_evidence_job_id: W3_EVIDENCE,
      date_from: "2026-01-22T20:54:01.392Z",
      date_to: "2026-02-21T20:54:01.392Z",
      window_index: 903,
      window_label: "P0.4.1 recovery W3",
      phase: "historical_sales_window",
    },
  },
];

if (!execute) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "dry_run",
        candidate_count: candidates.length,
        windows: recoveryJobs.map((j) => j.metadata),
        earliest: dry.earliest_missing,
        latest: dry.latest_missing,
        already_existing: dbIds.size,
        eligible_to_import: candidates.length,
        sales_before: salesBefore,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

/** @type {Record<string, unknown>[]} */
const importResults = [];
let imported = 0;
let skipped = 0;
let errors = 0;
const nowIso = new Date().toISOString();
const summaryStub = {
  synced_count: 0,
  created_count: 0,
  updated_count: 0,
  skipped_count: 0,
  skipped_cancelled_or_unavailable_count: 0,
  errors: /** @type {string[]} */ ([]),
};

for (const oid of candidates) {
  const { data: exists } = await sb
    .from("sales_orders")
    .select("id")
    .eq("marketplace_account_id", INSPRAZZO)
    .eq("external_order_id", oid)
    .maybeSingle();
  if (exists?.id) {
    skipped += 1;
    continue;
  }
  try {
    const detail = await fetchOrderById(token, oid, { marketplaceAccountId: INSPRAZZO });
    const result = await applyMlOrderDetailToMarketplaceSales(
      sb,
      acc.user_id,
      INSPRAZZO,
      acc.seller_company_id != null ? String(acc.seller_company_id) : null,
      detail,
      nowIso,
      summaryStub,
      token,
      { syncRunId: `p0_4_1_gap_recovery:${INSPRAZZO}`, syncType: "ml_historical_sales_backfill" },
      { syncType: "ml_historical_sales_backfill" },
    );
    if (result?.ok === false) {
      errors += 1;
      importResults.push({ external_order_id: oid, ok: false, reason: result?.reason ?? "apply_failed" });
      continue;
    }
    imported += 1;
    importResults.push({ external_order_id: oid, ok: true });
  } catch (e) {
    errors += 1;
    importResults.push({
      external_order_id: oid,
      ok: false,
      error: e?.message ? String(e.message).slice(0, 200) : String(e),
    });
  }
}

for (const job of recoveryJobs) {
  const { data: existing } = await sb
    .from("marketplace_account_sync_jobs")
    .select("id")
    .eq("marketplace_account_id", INSPRAZZO)
    .eq("job_type", "ml_historical_sales_backfill")
    .contains("metadata", { recovery_kind: "p0_4_1_gap_recovery", window_index: job.metadata.window_index })
    .maybeSingle();

  const payload = {
    status: "done",
    progress_current: 1,
    progress_total: 1,
    updated_at: nowIso,
    metadata: {
      ...job.metadata,
      ml_sales_import_api_total: candidates.length,
      ml_sales_import_saved: imported,
      recovery_completed_at: nowIso,
    },
  };

  if (existing?.id) {
    await sb.from("marketplace_account_sync_jobs").update(payload).eq("id", existing.id);
  } else {
    await sb.from("marketplace_account_sync_jobs").insert({ ...job, ...payload });
  }
}

const { count: salesAfter } = await sb
  .from("sales_orders")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", INSPRAZZO);

const janFebMl = await mlOrderIds(token, sellerId, "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
const janFebDbAfter = await dbOrderIdSet("2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
const janFebGap = [...janFebMl].filter((id) => !janFebDbAfter.has(id)).length;

const { count: billingAdmissions } = await sb
  .from("billing_billable_sale_admissions")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", INSPRAZZO)
  .gte("created_at", nowIso);

const out = {
  ok: errors === 0 && janFebGap === 0,
  imported,
  skipped,
  errors,
  sales_before: salesBefore,
  sales_after: salesAfter,
  sales_delta: (salesAfter ?? 0) - (salesBefore ?? 0),
  jan_feb_remaining_gap: janFebGap,
  billing_admissions_created_during_run: billingAdmissions ?? 0,
  zero_retrocharge_expected: true,
  import_sample: importResults.slice(0, 10),
  recovery_jobs_created: recoveryJobs.map((j) => j.metadata.window_index),
  w3_w4_preserved: [W3_EVIDENCE, W4_EVIDENCE],
};

const outPath = path.join(root, "scripts/output/P0_4_1_INSPRAZZO_GAP_RECOVERY.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (prevMaintenanceMode != null) process.env.DEV_GLOBAL_MAINTENANCE_MODE = prevMaintenanceMode;
