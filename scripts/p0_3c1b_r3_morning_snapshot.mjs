#!/usr/bin/env node
/**
 * P0.3-C.1B-R3 — Morning runtime snapshot (READ-ONLY).
 * Zero mutation. Compare vs yesterday checkpoint.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  resolveMlOrdersSearchSort,
  searchSellerOrdersPage,
} from "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { resolveIncrementalSalesWindow } from "../src/services/marketplace/mlIncrementalSalesPoll.js";

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const RF_ACCOUNT = "359327e4-9902-4213-a1c3-1de702ef92ee";
const RF_USER = "7f85f0fb-a058-4dc1-9e01-09a9bdc923cc";
const WITNESS = "2000018031307152";

const CHECKPOINT = {
  source: "P0_3C1M3_DEV_HOMOLOGATION.json",
  timestamp: "2026-08-21T20:28:07.892Z",
  sales_orders_total: null,
  watermark: "2026-08-21 19:05:07+00",
  rf_pending_count: 9,
};

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

function refFromUrl(url) {
  try {
    const m = new URL(url).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...parseEnvFile(path.join(root, ".env.vercel")) };
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
}

const ref = refFromUrl(env.SUPABASE_URL || "");
if (ref !== EXPECTED_REF) {
  console.error(JSON.stringify({ ok: false, error: "wrong_project", ref, expected: EXPECTED_REF }));
  process.exit(2);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RF_HINTS = ["rfmoveis", "rf móveis", "rf moveis", "lojasrf"];
const COMPARE_HINTS = [
  { key: "super_metal", patterns: ["super metal", "supermetal"] },
  { key: "insprazzo", patterns: ["insprazzo", "inspirazzo"] },
];

function nameBlob(a) {
  return `${a.ml_nickname ?? ""} ${a.account_alias ?? ""}`.toLowerCase();
}

function matchAccount(a, patterns) {
  return patterns.some((p) => nameBlob(a).includes(p));
}

async function mlOrderIds(accessToken, sellerId, accountId, fromIso, toIso) {
  const ids = new Set();
  let offset = 0;
  for (let page = 0; page < 30; page += 1) {
    const pg = await searchSellerOrdersPage(accessToken, sellerId, offset, 50, {
      dateFrom: fromIso,
      dateTo: toIso,
      marketplaceAccountId: accountId,
      sort: resolveMlOrdersSearchSort(),
    });
    for (const id of pg.orderIds ?? []) ids.add(String(id));
    if ((pg.orderIds?.length ?? 0) < 50) break;
    offset += 50;
  }
  return [...ids];
}

async function accountQuickSnapshot(acc, label) {
  const { count: salesTotal } = await sb
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("marketplace_account_id", acc.id);

  const { data: latest } = await sb
    .from("sales_orders")
    .select("external_order_id,date_created_marketplace,created_at")
    .eq("marketplace_account_id", acc.id)
    .order("date_created_marketplace", { ascending: false, nullsFirst: false })
    .limit(1);

  const { data: jobs } = await sb
    .from("marketplace_account_sync_jobs")
    .select("job_type,status,updated_at")
    .eq("marketplace_account_id", acc.id)
    .order("updated_at", { ascending: false })
    .limit(20);

  const jobCounts = {};
  for (const j of jobs ?? []) {
    const k = `${j.job_type}:${j.status}`;
    jobCounts[k] = (jobCounts[k] ?? 0) + 1;
  }

  return {
    label,
    account_id: acc.id,
    ml_nickname: acc.ml_nickname,
    sales_total: salesTotal ?? 0,
    watermark: acc.ml_sales_last_synced_order_created_to ?? null,
    ml_sales_last_sync_at: acc.ml_sales_last_sync_at ?? null,
    latest_order: latest?.[0] ?? null,
    recent_job_counts: jobCounts,
  };
}

const { data: accounts } = await sb
  .from("marketplace_accounts")
  .select(
    "id,user_id,external_seller_id,account_alias,ml_nickname,status,ml_sales_last_sync_at,ml_sales_last_synced_order_created_to",
  )
  .eq("marketplace", "mercado_livre");

const rfAcc = (accounts ?? []).find((a) => matchAccount(a, RF_HINTS));
if (!rfAcc) throw new Error("RF account not found");

const checkpointIso = CHECKPOINT.watermark?.includes("T")
  ? CHECKPOINT.watermark
  : `${CHECKPOINT.watermark?.replace(" ", "T")}`;

const { count: rfSalesTotal } = await sb
  .from("sales_orders")
  .select("id", { count: "exact", head: true })
  .eq("marketplace_account_id", RF_ACCOUNT);

const { data: newOrders } = await sb
  .from("sales_orders")
  .select("external_order_id,date_created_marketplace,created_at,quantity")
  .eq("marketplace_account_id", RF_ACCOUNT)
  .gt("date_created_marketplace", checkpointIso)
  .order("date_created_marketplace", { ascending: true });

const { data: maxOrder } = await sb
  .from("sales_orders")
  .select("external_order_id,date_created_marketplace")
  .eq("marketplace_account_id", RF_ACCOUNT)
  .order("date_created_marketplace", { ascending: false, nullsFirst: false })
  .limit(1);

const { data: rfPending } = await sb
  .from("billing_billable_sale_admissions")
  .select(
    "id,external_order_id,cycle_key,idempotency_key,official_order_at,classification_reason,snapshot_origin,admission_result",
  )
  .eq("marketplace_account_id", RF_ACCOUNT)
  .eq("admission_result", "PENDING_MANUAL_REVIEW")
  .order("created_at");

const witnessSale = await sb
  .from("sales_orders")
  .select("id,external_order_id,date_created_marketplace,quantity")
  .eq("marketplace_account_id", RF_ACCOUNT)
  .eq("external_order_id", WITNESS)
  .maybeSingle();

const witnessPending = await sb
  .from("billing_billable_sale_admissions")
  .select("id,cycle_key,admission_result")
  .eq("marketplace_account_id", RF_ACCOUNT)
  .eq("external_order_id", WITNESS)
  .eq("admission_result", "PENDING_MANUAL_REVIEW")
  .maybeSingle();

/** ML−DB set diff for recent window */
let setDiff = { missing_count: null, error: null };
const probeFrom = new Date(Date.now() - 48 * 3600000).toISOString();
const probeTo = new Date().toISOString();
try {
  const token = await getValidMLToken(rfAcc.user_id, { marketplaceAccountId: rfAcc.id });
  const sellerId = String(rfAcc.external_seller_id ?? "");
  const mlIds = await mlOrderIds(token, sellerId, rfAcc.id, probeFrom, probeTo);
  const { data: dbRows } = await sb
    .from("sales_orders")
    .select("external_order_id")
    .eq("marketplace_account_id", RF_ACCOUNT)
    .gte("date_created_marketplace", probeFrom)
    .lte("date_created_marketplace", probeTo);
  const dbSet = new Set((dbRows ?? []).map((r) => String(r.external_order_id)));
  const missing = mlIds.filter((id) => !dbSet.has(id));
  setDiff = {
    probe_from: probeFrom,
    probe_to: probeTo,
    ml_count: mlIds.length,
    db_count: dbRows?.length ?? 0,
    missing_count: missing.length,
    missing_sample: missing.slice(0, 10),
  };
} catch (e) {
  setDiff = { error: String(e?.message ?? e), missing_count: null };
}

/** Sales list API path — query same filters as list handler */
const { data: salesListSample } = await sb
  .from("sales_orders")
  .select("external_order_id,date_created_marketplace,created_at,quantity")
  .eq("user_id", RF_USER)
  .eq("marketplace_account_id", RF_ACCOUNT)
  .order("date_created_marketplace", { ascending: false, nullsFirst: false })
  .limit(15);

const newOrderIds = new Set((newOrders ?? []).map((o) => o.external_order_id));
const visibleNewInList = (salesListSample ?? []).filter((r) => newOrderIds.has(r.external_order_id));

const compares = {};
for (const c of COMPARE_HINTS) {
  const acc = (accounts ?? []).find((a) => matchAccount(a, c.patterns));
  if (acc) compares[c.key] = await accountQuickSnapshot(acc, c.key);
}

const gitBranch = sh("git branch --show-current");
const gitHead = sh("git log -1 --format=%H");
const gitHeadSubject = sh("git log -1 --format=%s");
const gitMainHead = sh("git log main -1 --format=%H 2>nul") ?? sh("git log origin/main -1 --format=%H");

let ghSchedule = null;
try {
  ghSchedule = sh("gh run list --workflow=marketplace-sync-dev.yml --limit 1 --json databaseId,status,conclusion,createdAt,headSha 2>nul");
  if (ghSchedule) ghSchedule = JSON.parse(ghSchedule);
} catch {
  ghSchedule = null;
}

const freshnessPass =
  setDiff.error == null &&
  (setDiff.missing_count === 0 ||
    (setDiff.missing_count > 0 &&
      (newOrders ?? []).length === 0 &&
      setDiff.missing_sample?.every?.((id) => !newOrderIds.has(id)) === false));

const blockReason =
  setDiff.missing_count > 0 && (newOrders ?? []).some((o) => !setDiff.missing_sample?.includes(o.external_order_id))
    ? "ml_db_gap_with_new_sales"
    : setDiff.missing_count > 0 && (newOrders ?? []).length > 0
      ? "ml_db_missing_and_new_orders_present"
      : null;

const report = {
  ok: !blockReason,
  generated_at_utc: new Date().toISOString(),
  project_ref: ref,
  temporal: {
    git_branch: gitBranch,
    git_head: gitHead,
    git_head_subject: gitHeadSubject,
    git_main_head: gitMainHead,
    backend_dev_baseline_note: "4af0002 = DEV hardening deploy; main HEAD separate",
    c1m3_commit: "8978c983b16a8b413f1717f5f46d3bdae9d5aed8",
    github_marketplace_schedule_last: ghSchedule,
  },
  checkpoint: CHECKPOINT,
  rf: {
    account_id: RF_ACCOUNT,
    sales_orders_total: rfSalesTotal,
    sales_delta_since_checkpoint: null,
    max_date_created_marketplace: maxOrder?.[0]?.date_created_marketplace ?? null,
    watermark: rfAcc.ml_sales_last_synced_order_created_to,
    ml_sales_last_sync_at: rfAcc.ml_sales_last_sync_at,
    new_orders_since_checkpoint: (newOrders ?? []).map((o) => ({
      external_order_id: o.external_order_id,
      date_created_marketplace: o.date_created_marketplace,
      quantity: o.quantity ?? 1,
      orders: 1,
      units: Number(o.quantity ?? 1),
    })),
    new_orders_count: newOrders?.length ?? 0,
    pending_admissions_count: rfPending?.length ?? 0,
    pending_admissions: rfPending,
    witness: {
      external_order_id: WITNESS,
      sale: witnessSale.data ? 1 : 0,
      pending: witnessPending.data ? 1 : 0,
      admission_id: witnessPending.data?.id ?? null,
      cycle_key: witnessPending.data?.cycle_key ?? null,
      reserved: 0,
    },
    set_diff: setDiff,
    sales_api_visibility: {
      list_top15_count: salesListSample?.length ?? 0,
      new_orders_visible_in_top15: visibleNewInList.length,
      new_orders_visible: visibleNewInList.map((r) => ({
        external_order_id: r.external_order_id,
        date_created_marketplace: r.date_created_marketplace,
      })),
      duplicates_in_top15:
        salesListSample?.length !== new Set(salesListSample?.map((r) => r.external_order_id)).size,
    },
  },
  compares,
  phase0_verdict: blockReason ? "STOP" : "PASS",
  block_reason: blockReason,
};

const witnessPath = path.join(root, "scripts/output/P0_3B_RF_WITNESS_CHECK.json");
if (fs.existsSync(witnessPath)) {
  const prev = JSON.parse(fs.readFileSync(witnessPath, "utf8"));
  report.rf.sales_delta_since_checkpoint =
    (rfSalesTotal ?? 0) - (prev.sales_orders_total ?? rfSalesTotal ?? 0);
  report.checkpoint.sales_orders_total = prev.sales_orders_total ?? null;
}

const outPath = path.join(root, "scripts/output/P0_3C1B_R3_MORNING_SNAPSHOT.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (blockReason) process.exit(3);
