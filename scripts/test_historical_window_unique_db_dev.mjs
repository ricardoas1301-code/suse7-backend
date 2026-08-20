#!/usr/bin/env node
/**
 * DB-UNIQ-01..05 — prova UNIQUE real DEV (fixture isolada, cleanup garantido).
 * Não toca janelas reais Insprazzo (window_index 0–9).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { reconcileHistoricalSalesBackfillJobs } from "../src/services/marketplace/createMlInitialSyncJobs.js";

const EXPECTED_DEV_REF = "alkelcaoexxbamqddaqv";
const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const WINDOW1_ID = "195cb223-44c8-4d9d-b277-88647cc701d7";
const TEST_WI = 99997;
const TEST_WI_B = 99996;
const TEST_FROM = "2099-01-01T00:00:00.000Z";
const TEST_TO = "2099-01-31T00:00:00.000Z";
const TEST_FROM_B = "2099-02-01T00:00:00.000Z";
const TEST_TO_B = "2099-02-28T00:00:00.000Z";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "..", "scripts", "output");

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

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const createdIds = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...process.env };
const projectRef = refFromUrl(env.SUPABASE_URL || "");
if (projectRef !== EXPECTED_DEV_REF) {
  console.error(JSON.stringify({ ok: false, stop: "wrong_target", projectRef }));
  process.exit(3);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function cleanupTestRows() {
  if (!createdIds.length) return;
  await sb.from("marketplace_account_sync_jobs").delete().in("id", createdIds);
  createdIds.length = 0;
}

async function getAccountTemplate() {
  const { data } = await sb
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id,user_id,seller_company_id,marketplace")
    .eq("job_type", "ml_historical_sales_backfill")
    .limit(1)
    .maybeSingle();
  if (!data?.marketplace_account_id || !data?.user_id) throw new Error("no_template_account");
  return data;
}

async function getSecondAccount(firstAccId) {
  const { data } = await sb
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id,user_id,seller_company_id,marketplace")
    .eq("job_type", "ml_historical_sales_backfill")
    .neq("marketplace_account_id", firstAccId)
    .limit(1)
    .maybeSingle();
  return data;
}

function testRow(tpl, accId, wi, df, dt, jobType = "ml_historical_sales_backfill") {
  return {
    user_id: tpl.user_id,
    marketplace: tpl.marketplace ?? "mercado_livre",
    marketplace_account_id: accId,
    seller_company_id: tpl.seller_company_id ?? null,
    job_type: jobType,
    status: "pending",
    metadata: {
      wave: "db_uniq_test_fixture",
      window_index: wi,
      date_from: df,
      date_to: dt,
      target_history_end_iso: TEST_TO,
    },
    updated_at: new Date().toISOString(),
  };
}

async function insertOne(row) {
  const { data, error } = await sb.from("marketplace_account_sync_jobs").insert(row).select("id").maybeSingle();
  return { data, error };
}

try {
  const tpl = await getAccountTemplate();
  const accA = String(tpl.marketplace_account_id);
  const accBRow = await getSecondAccount(accA);
  const accB = accBRow?.marketplace_account_id ? String(accBRow.marketplace_account_id) : accA;

  // DB-UNIQ-01 — duplicata direta
  {
    const row = testRow(tpl, accA, TEST_WI, TEST_FROM, TEST_TO);
    const first = await insertOne(row);
    assert("DB-UNIQ-01 first insert ok", !first.error && first.data?.id);
    if (first.data?.id) createdIds.push(first.data.id);
    const dup = await insertOne(row);
    assert("DB-UNIQ-01 duplicate 23505", dup.error?.code === "23505" || /duplicate|unique/i.test(dup.error?.message || ""));
  }

  // DB-UNIQ-02 — contas diferentes permitidas
  if (accB !== accA) {
    const rowB = testRow(accBRow ?? tpl, accB, TEST_WI, TEST_FROM, TEST_TO);
    const insB = await insertOne(rowB);
    assert("DB-UNIQ-02 other account allowed", !insB.error && insB.data?.id);
    if (insB.data?.id) createdIds.push(insB.data.id);
  } else {
    assert("DB-UNIQ-02 skipped single account dev", true);
  }

  // DB-UNIQ-03 — windows diferentes mesma conta
  {
    const rowB = testRow(tpl, accA, TEST_WI_B, TEST_FROM_B, TEST_TO_B);
    const ins = await insertOne(rowB);
    assert("DB-UNIQ-03 different window ok", !ins.error && ins.data?.id);
    if (ins.data?.id) createdIds.push(ins.data.id);
  }

  // DB-UNIQ-04 — outro job_type não afetado
  {
    const row = testRow(tpl, accA, TEST_WI, TEST_FROM, TEST_TO, "ml_initial_sales_recent");
    const ins = await insertOne(row);
    assert("DB-UNIQ-04 other job_type ok", !ins.error && ins.data?.id);
    if (ins.data?.id) createdIds.push(ins.data.id);
  }

  // DB-UNIQ-05 — race paralela
  {
    await cleanupTestRows();
    const raceWi = 99995;
    const raceFrom = "2099-03-01T00:00:00.000Z";
    const raceTo = "2099-03-31T00:00:00.000Z";
    const row = testRow(tpl, accA, raceWi, raceFrom, raceTo);
    const [a, b] = await Promise.all([insertOne(row), insertOne(row)]);
    const okCount = [a, b].filter((r) => !r.error && r.data?.id).length;
    const dupCount = [a, b].filter((r) => r.error?.code === "23505" || /duplicate|unique/i.test(r.error?.message || "")).length;
    assert("DB-UNIQ-05 one success", okCount === 1);
    assert("DB-UNIQ-05 one duplicate", dupCount === 1);
    for (const r of [a, b]) if (r.data?.id) createdIds.push(r.data.id);
    const { data: rows } = await sb
      .from("marketplace_account_sync_jobs")
      .select("id")
      .eq("marketplace_account_id", accA)
      .eq("job_type", "ml_historical_sales_backfill")
      .filter("metadata->>window_index", "eq", String(raceWi));
    assert("DB-UNIQ-05 final one row", (rows ?? []).length === 1);
  }

  // Reconcile concorrente com UNIQUE real — conta sem histórico prévio
  {
    const { data: accounts } = await sb.from("marketplace_accounts").select("id,user_id").limit(50);
    let testAcc = null;
    for (const acc of accounts ?? []) {
      const { count } = await sb
        .from("marketplace_account_sync_jobs")
        .select("id", { count: "exact", head: true })
        .eq("marketplace_account_id", acc.id)
        .eq("job_type", "ml_historical_sales_backfill");
      if ((count ?? 0) === 0 && acc.user_id) {
        testAcc = acc;
        break;
      }
    }
    if (testAcc) {
      const ctx = {
        userId: String(testAcc.user_id),
        marketplaceAccountId: String(testAcc.id),
        sellerCompanyId: null,
      };
      const [r1, r2] = await Promise.all([
        reconcileHistoricalSalesBackfillJobs(sb, ctx),
        reconcileHistoricalSalesBackfillJobs(sb, ctx),
      ]);
      const { data: after, count } = await sb
        .from("marketplace_account_sync_jobs")
        .select("id", { count: "exact" })
        .eq("marketplace_account_id", testAcc.id)
        .eq("job_type", "ml_historical_sales_backfill");
      for (const row of after ?? []) createdIds.push(row.id);
      const expected = r1.expected_total ?? r2.expected_total ?? 10;
      assert("DB-RECONCILE-RACE final expected", (count ?? after?.length ?? 0) === expected);
      assert(
        "DB-RECONCILE-RACE created bounded",
        (r1.created ?? 0) + (r2.created ?? 0) >= expected && (r1.created ?? 0) + (r2.created ?? 0) <= expected * 2
      );
      await sb
        .from("marketplace_account_sync_jobs")
        .delete()
        .eq("marketplace_account_id", testAcc.id)
        .eq("job_type", "ml_historical_sales_backfill");
    } else {
      assert("DB-RECONCILE-RACE skipped no empty account", true);
    }
  }
} finally {
  await cleanupTestRows();
}

// Insprazzo read-only gate
const { data: window1 } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", WINDOW1_ID).maybeSingle();
const { data: inspHist } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,status")
  .eq("marketplace_account_id", INSPRAZZO_ACCOUNT)
  .eq("job_type", "ml_historical_sales_backfill");

assert("WINDOW1 pending", window1?.status === "pending");
assert("WINDOW1 updated_at unchanged", window1?.updated_at === "2026-08-20T20:54:01.392+00:00");
assert("INSPRAZZO 10 total", (inspHist ?? []).length === 10);
assert("INSPRAZZO 1 done", (inspHist ?? []).filter((r) => r.status === "done").length === 1);

const report = {
  generated_at: new Date().toISOString(),
  target: projectRef,
  failures,
  window1: window1
    ? { id: window1.id, status: window1.status, updated_at: window1.updated_at, progress: `${window1.progress_current}/${window1.progress_total}` }
    : null,
  insprazzo: {
    total: (inspHist ?? []).length,
    done: (inspHist ?? []).filter((r) => r.status === "done").length,
    pending: (inspHist ?? []).filter((r) => r.status === "pending").length,
  },
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `DB_UNIQ_TESTS_${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

const ok = failures.length === 0;
console.log(JSON.stringify({ ok, output: outFile, ...report }, null, 2));
process.exit(ok ? 0 : 2);
