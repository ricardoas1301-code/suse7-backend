#!/usr/bin/env node
/**
 * P0.4 — Final DEV sync normalization audit (read-only + evidence).
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

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const ACCOUNTS = {
  rf: { id: "359327e4-9902-4213-a1c3-1de702ef92ee", hints: ["rfmoveis", "rf móveis", "rf moveis", "lojasrf"] },
  insprazzo: { id: null, hints: ["insprazzo", "inspirazzo"] },
  super_metal: { id: null, hints: ["super metal", "supermetal"] },
};
const WITNESS_ORDERS = ["2000018031307152", "2000018055213616"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schedulerRoot = path.resolve(root, "..", "suse7-scheduler");

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

function dbQuery(sql) {
  const out = execSync(`npx supabase db query --linked ${JSON.stringify(sql)}`, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const jsonStart = out.indexOf("{");
  if (jsonStart < 0) throw new Error(`db parse fail: ${out.slice(0, 200)}`);
  const parsed = JSON.parse(out.slice(jsonStart));
  if (parsed._tag === "Error") throw new Error(parsed.error?.message ?? out);
  return parsed.rows ?? [];
}

function sh(cmd, cwd = root) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function nameBlob(a) {
  return `${a.ml_nickname ?? ""} ${a.account_alias ?? ""}`.toLowerCase();
}

function matchAccount(a, patterns) {
  return patterns.some((p) => nameBlob(a).includes(p));
}

function orderFromResource(resource) {
  const m = String(resource ?? "").match(/\/orders\/(\d+)/i);
  return m ? m[1] : null;
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

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...parseEnvFile(path.join(root, ".env.vercel")) };
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: accounts } = await sb
  .from("marketplace_accounts")
  .select(
    "id,user_id,external_seller_id,account_alias,ml_nickname,status,ml_sales_last_sync_at,ml_sales_last_synced_order_created_to",
  )
  .eq("marketplace", "mercado_livre");

for (const [key, cfg] of Object.entries(ACCOUNTS)) {
  if (!cfg.id) {
    const found = (accounts ?? []).find((a) => matchAccount(a, cfg.hints));
    if (found) cfg.id = found.id;
  }
}

async function accountSnapshot(label, accountId) {
  const acc = (accounts ?? []).find((a) => a.id === accountId);
  if (!acc) return { label, error: "account_not_found" };

  const { count: salesTotal } = await sb
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("marketplace_account_id", accountId);

  const { data: earliest } = await sb
    .from("sales_orders")
    .select("external_order_id,date_created_marketplace")
    .eq("marketplace_account_id", accountId)
    .order("date_created_marketplace", { ascending: true, nullsFirst: false })
    .limit(1);

  const { data: latest } = await sb
    .from("sales_orders")
    .select("external_order_id,date_created_marketplace")
    .eq("marketplace_account_id", accountId)
    .order("date_created_marketplace", { ascending: false, nullsFirst: false })
    .limit(1);

  const { data: jobs } = await sb
    .from("marketplace_account_sync_jobs")
    .select("job_type,status,updated_at,created_at")
    .eq("marketplace_account_id", accountId)
    .order("updated_at", { ascending: false })
    .limit(30);

  const jobSummary = {};
  for (const j of jobs ?? []) {
    const k = `${j.job_type}:${j.status}`;
    jobSummary[k] = (jobSummary[k] ?? 0) + 1;
  }

  const probeFrom = new Date(Date.now() - 48 * 3600000).toISOString();
  const probeTo = new Date().toISOString();
  let setDiff = { missing_count: null, error: null };
  try {
    const token = await getValidMLToken(acc.user_id, { marketplaceAccountId: acc.id });
    const mlIds = await mlOrderIds(token, String(acc.external_seller_id ?? ""), acc.id, probeFrom, probeTo);
    const { data: dbRows } = await sb
      .from("sales_orders")
      .select("external_order_id")
      .eq("marketplace_account_id", accountId)
      .gte("date_created_marketplace", probeFrom)
      .lte("date_created_marketplace", probeTo);
    const dbSet = new Set((dbRows ?? []).map((r) => String(r.external_order_id)));
    const missing = mlIds.filter((id) => !dbSet.has(id));
    setDiff = { probe_from: probeFrom, probe_to: probeTo, ml_count: mlIds.length, db_count: dbSet.size, missing_count: missing.length, missing_sample: missing.slice(0, 5) };
  } catch (e) {
    setDiff = { error: e instanceof Error ? e.message : String(e) };
  }

  const { data: dupScan } = await sb
    .from("sales_orders")
    .select("external_order_id")
    .eq("marketplace_account_id", accountId);
  const dupMap = {};
  for (const r of dupScan ?? []) {
    const id = String(r.external_order_id);
    dupMap[id] = (dupMap[id] ?? 0) + 1;
  }
  const duplicateOrders = Object.entries(dupMap).filter(([, c]) => c > 1).length;

  return {
    label,
    account_id: accountId,
    ml_nickname: acc.ml_nickname,
    sales_total: salesTotal ?? 0,
    earliest_order: earliest?.[0] ?? null,
    latest_order: latest?.[0] ?? null,
    watermark: acc.ml_sales_last_synced_order_created_to ?? null,
    ml_sales_last_sync_at: acc.ml_sales_last_sync_at ?? null,
    job_counts: jobSummary,
    recent_jobs: (jobs ?? []).slice(0, 8).map((j) => ({ job_type: j.job_type, status: j.status, updated_at: j.updated_at })),
    set_diff_48h: setDiff,
    duplicate_logical_orders: duplicateOrders,
  };
}

const rfBilling = dbQuery(
  "SELECT admission_result, COUNT(*)::int AS c FROM billing_billable_sale_admissions WHERE marketplace_account_id='359327e4-9902-4213-a1c3-1de702ef92ee' GROUP BY admission_result ORDER BY admission_result;",
);

const t20Rows = dbQuery(
  "SELECT id, external_order_id, admission_result, cycle_key, reserved_at FROM billing_billable_sale_admissions WHERE external_order_id IN ('T20P_mt3bv784_0','T20P_mt3bw39c_0') ORDER BY external_order_id;",
);

const webhookEvents = dbQuery(
  "SELECT id, topic, resource, status, created_at, processed_at, completed_at FROM ml_webhook_events WHERE topic='orders_v2' AND (resource LIKE '%2000018031307152%' OR resource LIKE '%2000018055213616%' OR resource LIKE '%2000018063922238%') ORDER BY created_at DESC LIMIT 20;",
);

const recentWebhookOrders = dbQuery(
  "SELECT id, topic, resource, status, created_at, processed_at FROM ml_webhook_events WHERE topic='orders_v2' AND status IN ('done','processed') ORDER BY created_at DESC LIMIT 15;",
);

const webhookWitnesses = [];
for (const ev of recentWebhookOrders) {
  const orderId = orderFromResource(ev.resource);
  if (!orderId) continue;
  const sale = await sb
    .from("sales_orders")
    .select("external_order_id,date_created_marketplace,created_at,marketplace_account_id")
    .eq("external_order_id", orderId)
    .maybeSingle();
  if (!sale.data) continue;
  const createdMs = sale.data.created_at ? Date.parse(sale.data.created_at) : null;
  const webhookMs = ev.created_at ? Date.parse(ev.created_at) : null;
  const mpMs = sale.data.date_created_marketplace ? Date.parse(sale.data.date_created_marketplace) : null;
  webhookWitnesses.push({
    external_order_id: orderId,
    webhook_event_id: ev.id,
    webhook_status: ev.status,
    webhook_created_at: ev.created_at,
    webhook_processed_at: ev.processed_at,
    sale_created_at: sale.data.created_at,
    date_created_marketplace: sale.data.date_created_marketplace,
    latency_webhook_received_minus_mp_ms: webhookMs != null && mpMs != null ? webhookMs - mpMs : null,
    latency_sale_persisted_minus_webhook_ms: createdMs != null && webhookMs != null ? createdMs - webhookMs : null,
    latency_sale_persisted_minus_mp_ms: createdMs != null && mpMs != null ? createdMs - mpMs : null,
  });
}

const marketplaceRuns = JSON.parse(
  sh('gh run list --workflow=marketplace-account-sync-dev.yml --limit 3 --json databaseId,event,conclusion,createdAt,headSha', schedulerRoot) || "[]",
);

const billingRuns = JSON.parse(
  sh('gh run list --workflow=billing-admission-reconciler-dev.yml --limit 2 --json databaseId,event,conclusion,createdAt,headSha', schedulerRoot) || "[]",
);

const report = {
  generated_at: new Date().toISOString(),
  mission: "P0.4_FINAL_SYNC_NORMALIZATION",
  git: {
    backend_dev_sha: sh("git rev-parse HEAD"),
    backend_main_sha: sh("git rev-parse main"),
    scheduler_sha: sh("git rev-parse HEAD", schedulerRoot),
  },
  orchestration_inventory: {
    marketplace_sync_owner: {
      canonical: "suse7-scheduler/marketplace-account-sync-dev.yml",
      trigger: "schedule 2/5 * * * *",
      endpoint: "POST /api/jobs/marketplace-account-sync",
      backend_duplicate: "suse7-backend/marketplace-account-sync-cron-dev.yml schedule OFF (superseded)",
    },
    webhook_ingest: {
      owner: "POST /api/ml/webhook (backend DEV hosted)",
      processor_drain: "suse7-backend/ml-webhook-events-cron-dev.yml schedule */1 * * * *",
      job: "POST /api/jobs/ml-webhook-events",
    },
    scanner_fallback: {
      owner: "incremental_sales_poll inside marketplace-account-sync worker",
      cadence: "every marketplace sync tick (scheduler 2/5)",
    },
    billing: {
      owner: "suse7-scheduler/billing-admission-reconciler-dev.yml",
      cadence: "9/15 * * * *",
    },
    vercel_crons: "competition-daily-snapshot + daily-sales-summary only (no marketplace sync)",
    frontend: "observer only — sync-status display, no drain nudge",
  },
  marketplace_schedule_rca: {
    question: "Who woke freshness while backend marketplace-account-sync-cron-dev.yml schedule was commented?",
    answer: "suse7-scheduler marketplace-account-sync-dev.yml (schedule ON 2/5 * * * *)",
    evidence: "GitHub runs event=schedule workflowName=Marketplace Account Sync Cron (DEV)",
    recent_runs: marketplaceRuns,
  },
  accounts: {
    rf: await accountSnapshot("rf", ACCOUNTS.rf.id),
    insprazzo: await accountSnapshot("insprazzo", ACCOUNTS.insprazzo.id),
    super_metal: await accountSnapshot("super_metal", ACCOUNTS.super_metal.id),
  },
  rf_billing: rfBilling,
  webhook_witnesses: webhookWitnesses.slice(0, 10),
  webhook_events_for_known_orders: webhookEvents,
  t20_expired_legacy: t20Rows,
  natural_runs: {
    marketplace: marketplaceRuns.filter((r) => r.event === "schedule").slice(0, 2),
    billing: billingRuns.filter((r) => r.event === "schedule").slice(0, 2),
  },
  prod: "UNTOUCHED",
};

const outPath = path.join(root, "scripts/output/P0_4_FINAL_SYNC_AUDIT.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, outPath, rf: report.accounts.rf, webhook_witness_count: webhookWitnesses.length }, null, 2));
