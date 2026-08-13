#!/usr/bin/env node
/**
 * DEV.V2 P0-CLOSE — existing DB safety + fresh seed + git trackability
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "..");
const FRONTEND = path.join(BACKEND, "..", "suse7-frontend");
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";
const WORKSPACE = path.join(__dirname, "supabase-local-replay-workspace");

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 100 * 1024 * 1024, ...opts });
}

function supabase(args) {
  return run(`supabase ${args}`, { cwd: WORKSPACE });
}

async function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getContainer() {
  const r = run('docker ps --filter "name=supabase_db_supabase-local-replay-workspace" --format "{{.Names}}"');
  return r.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? null;
}

function psql(sql, container) {
  return spawnSync(
    "docker",
    ["exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
    { encoding: "utf8" },
  );
}

function psqlFile(filePath, container) {
  const content = fs.readFileSync(filePath, "utf8");
  return spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: content, encoding: "utf8" },
  );
}

async function resetSupabase() {
  supabase("stop --no-backup");
  await sleepMs(15000);
  run('docker ps -a --filter "name=supabase-local-replay-workspace" -q | ForEach-Object { docker rm -f $_ }');
  run('docker volume ls --filter "name=supabase-local-replay-workspace" -q | ForEach-Object { docker volume rm -f $_ }');
  await sleepMs(8000);
  const start = supabase("start");
  if (start.status !== 0) throw new Error(`supabase start failed: ${start.stderr}`);
  for (let i = 0; i < 60; i++) {
    if (getContainer()) break;
    await sleepMs(2000);
  }
  if (!getContainer()) throw new Error("DB not ready");
}

function applyMinimalSchema(container) {
  const baseline = path.join(FRONTEND, "supabase/migrations/20260301215430_baseline_public_from_prod.sql");
  const bridge = path.join(FRONTEND, "supabase/migrations/20260301215959_baseline_sales_schema_bridge.sql");
  const core = path.join(FRONTEND, "supabase/migrations/20260301220000_core_schema_bootstrap.sql");
  const schema = path.join(FRONTEND, "supabase/migrations/20260301220001_plans_commercial_schema_bootstrap.sql");
  const seed = path.join(FRONTEND, "supabase/migrations/20260301220002_plans_fresh_initial_catalog_seed.sql");
  for (const f of [baseline, bridge, core]) {
    const r = psqlFile(f, container);
    if (r.status !== 0) throw new Error(`fail ${path.basename(f)}: ${r.stderr}`);
  }
  return { schema, seed };
}

function gitCheckIgnore(relPath) {
  const r = spawnSync("git", ["check-ignore", "-v", relPath], { cwd: FRONTEND, encoding: "utf8" });
  if (r.status !== 0) return { ignored: false, output: null };
  const output = (r.stdout || r.stderr || "").trim();
  // Regra de negação (!) = arquivo explicitamente permitido — não ignorado
  const ignored = !output.includes(":!");
  return { ignored, output };
}

function scanBaselinePii() {
  const baseline = fs.readFileSync(path.join(FRONTEND, "supabase/migrations/20260301215430_baseline_public_from_prod.sql"), "utf8");
  const patterns = [
    { name: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
    { name: "jwt", re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
    { name: "insert_tenant", re: /INSERT\s+INTO\s+public\.(profiles|seller_companies|billing_)/i },
    { name: "cnpj_literal", re: /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/ },
  ];
  const hits = patterns.filter((p) => p.re.test(baseline)).map((p) => p.name);
  return { pass: hits.length === 0, hits, has_insert_plans: /INSERT\s+INTO\s+.*plans/i.test(baseline) };
}

async function testExistingDivergent(container) {
  const schema = path.join(FRONTEND, "supabase/migrations/20260301220001_plans_commercial_schema_bootstrap.sql");
  const seed = path.join(FRONTEND, "supabase/migrations/20260301220002_plans_fresh_initial_catalog_seed.sql");
  psql("DELETE FROM public.plans", container);
  if (psqlFile(schema, container).status !== 0) return { pass: false, step: "schema" };
  const ins = psql(
    `INSERT INTO public.plans (name, id, plan_key, price, price_monthly, price_cents, sales_limit_monthly, billing_required, is_active, pricing_mode, sort_order)
     VALUES
     ('Baby', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'baby', 77.00, 77.00, 7700, 31, true, true, 'fixed', 10),
     ('Start', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'start', 123.00, 123.00, 12300, 181, true, true, 'fixed', 20)`,
    container,
  );
  if (ins.status !== 0) return { pass: false, step: "insert", stderr: ins.stderr };
  if (psqlFile(seed, container).status !== 0) return { pass: false, step: "seed" };
  const baby = psql("SELECT price_monthly::text, sales_limit_monthly::text, id::text FROM public.plans WHERE plan_key='baby'", container).stdout.trim();
  const start = psql("SELECT price_monthly::text, sales_limit_monthly::text FROM public.plans WHERE plan_key='start'", container).stdout.trim();
  const count = psql("SELECT count(*)::text FROM public.plans", container).stdout.trim();
  const pass = baby.startsWith("77.00|31|bbbbbbbb") && start.startsWith("123.00|181") && count === "2";
  return { pass, baby, start, count, preserved: pass };
}

async function testExistingPartial(container) {
  const schema = path.join(FRONTEND, "supabase/migrations/20260301220001_plans_commercial_schema_bootstrap.sql");
  const seed = path.join(FRONTEND, "supabase/migrations/20260301220002_plans_fresh_initial_catalog_seed.sql");
  psql("DELETE FROM public.plans", container);
  if (psqlFile(schema, container).status !== 0) return { pass: false, step: "schema" };
  const ins = psql(
    `INSERT INTO public.plans (name, price, price_monthly, sales_limit_monthly, billing_required, is_active, pricing_mode)
     VALUES ('LegacyPlan', 49.00, 49.00, 99, true, true, 'fixed')`,
    container,
  );
  if (ins.status !== 0) return { pass: false, step: "insert", stderr: ins.stderr };
  psqlFile(seed, container);
  const count = psql("SELECT count(*)::text FROM public.plans", container).stdout.trim();
  const price = psql("SELECT price_monthly::text FROM public.plans WHERE name='LegacyPlan'", container).stdout.trim();
  const planKey = psql("SELECT plan_key FROM public.plans WHERE name='LegacyPlan'", container).stdout.trim();
  return {
    pass: count === "1" && price === "49.00" && planKey === "",
    count,
    price,
    plan_key_backfill: planKey || null,
    note: "partial catalog preserved; seed skipped; no auto-add of missing 7 plans",
  };
}

async function testFreshSeed(container) {
  psql("DELETE FROM public.plans", container);
  const schema = path.join(FRONTEND, "supabase/migrations/20260301220001_plans_commercial_schema_bootstrap.sql");
  const seed = path.join(FRONTEND, "supabase/migrations/20260301220002_plans_fresh_initial_catalog_seed.sql");
  psqlFile(schema, container);
  psqlFile(seed, container);
  const count = psql("SELECT count(*)::text FROM public.plans", container).stdout.trim();
  const baby = psql("SELECT sales_limit_monthly::text, price_cents::text FROM public.plans WHERE plan_key='baby'", container).stdout.trim();
  return { pass: count === "8" && baby === "50|5900", count, baby };
}

function buildTrackabilityManifest() {
  const files = [
    "suse7-frontend/supabase/migrations/20260301215430_baseline_public_from_prod.sql",
    "suse7-frontend/supabase/migrations/20260301215959_baseline_sales_schema_bridge.sql",
    "suse7-frontend/supabase/migrations/20260301220000_core_schema_bootstrap.sql",
    "suse7-frontend/supabase/migrations/20260301220001_plans_commercial_schema_bootstrap.sql",
    "suse7-frontend/supabase/migrations/20260301220002_plans_fresh_initial_catalog_seed.sql",
    "suse7-frontend/supabase/migrations/20260328120001_sales_order_items_rpc_compat.sql",
    "suse7-backend/supabase/migrations/20260510130000_marketplace_account_sales_import_coverage.sql",
    "suse7-backend/supabase/migrations/20260513190000_billing_payment_methods.sql",
    "suse7-backend/supabase/migrations/20260812130000_legal_document_acceptances.sql",
    "suse7-backend/scripts/dev_v2_supabase_local_replay.mjs",
  ];
  return files.map((f) => {
    const abs = f.startsWith("suse7-frontend") ? path.join(FRONTEND, f.replace("suse7-frontend/", "")) : path.join(BACKEND, f.replace("suse7-backend/", ""));
    const rel = f.replace(/^suse7-frontend\//, "").replace(/^suse7-backend\//, "");
    const repo = f.startsWith("suse7-frontend") ? FRONTEND : BACKEND;
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", rel], { cwd: repo, encoding: "utf8" }).status === 0;
    const ignore = /baseline|bridge/.test(path.basename(f)) ? gitCheckIgnore(rel) : { ignored: false, output: null };
    let status = "NEW_TRACKABLE";
    if (tracked) status = "ALREADY_TRACKED";
    else if (ignore.ignored) status = "IGNORED";
    else if (!fs.existsSync(abs)) status = "MISSING";
    return { file: f, status, gitignore: ignore.output || null, exists: fs.existsSync(abs) };
  });
}

async function main() {
  const results = { generated_at: new Date().toISOString() };

  results.git_trackability = {
    baseline: gitCheckIgnore("supabase/migrations/20260301215430_baseline_public_from_prod.sql"),
    bridge: gitCheckIgnore("supabase/migrations/20260301215959_baseline_sales_schema_bridge.sql"),
    manifest: buildTrackabilityManifest(),
    required_ignored: 0,
  };
  results.git_trackability.required_ignored = results.git_trackability.manifest.filter(
    (m) => m.status === "IGNORED" && !m.file.includes("dev_v2"),
  ).length;

  results.baseline_pii_scan = scanBaselinePii();

  await resetSupabase();
  const container = getContainer();
  applyMinimalSchema(container);

  results.fresh_seed = await testFreshSeed(container);
  await resetSupabase();
  applyMinimalSchema(getContainer());
  results.existing_divergent = await testExistingDivergent(getContainer());
  await resetSupabase();
  applyMinimalSchema(getContainer());
  results.existing_partial = await testExistingPartial(getContainer());

  results.plan_key_identity_backfill = {
    decision: "plan_key preenchido somente quando NULL via mapa name→plan_key inequívoco",
    commercial_fields: "never overwritten on existing rows",
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_FRESH_EXISTING_SAFETY_${RUN_DATE}.json`), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(OUT, `DEV_V2_GIT_TRACKABILITY_AUDIT_${RUN_DATE}.json`),
    JSON.stringify(results.git_trackability, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `DEV_V2_CANONICAL_REPLAY_FILES_${RUN_DATE}.json`),
    JSON.stringify({ manifest: results.git_trackability.manifest, required_ignored: results.git_trackability.required_ignored }, null, 2),
  );

  const allPass =
    results.fresh_seed.pass &&
    results.existing_divergent.pass &&
    results.existing_partial.pass &&
    results.git_trackability.required_ignored === 0 &&
    !results.git_trackability.baseline.ignored &&
    !results.git_trackability.bridge.ignored &&
    results.baseline_pii_scan.pass;

  console.log(JSON.stringify({ mission: "DEV.V2.REPLAY-FOUNDATION-P0-CLOSE.07", allPass, results }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
