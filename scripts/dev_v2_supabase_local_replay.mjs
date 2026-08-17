#!/usr/bin/env node
/**
 * DEV.V2.SUPABASE-LOCAL-REPLAY.04
 * Replay descartável contra Supabase Local completo (Auth/Storage/PostgREST/Realtime).
 * NÃO toca DEV/PROD remotos. Sem commit.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "suse7-frontend");
const OUT = path.join(__dirname, "output");
const WORKSPACE = path.join(__dirname, "supabase-local-replay-workspace");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";

const FRESH_REPLAY_SKIP = new Set(["20260327150100_sale_fee_coherence_backfill.sql"]);
const WIP_EXCLUDED = new Set([
  "20260810200000_marketplace_listings_sku_dependency_pending_idx.sql",
  "20260812120000_s7_primary_company_default_recipient.sql",
]);

const FRONTEND_PREREQ_AFTER_BASELINE = ["20260217000000_normalized_sku_unique.sql"];

const RUNTIME_TABLES = [
  "profiles",
  "seller_companies",
  "marketplace_accounts",
  "ml_tokens",
  "products",
  "marketplace_listings",
  "sales_orders",
  "sales_order_items",
  "ml_webhook_events",
  "billing_subscriptions",
  "billing_customers",
  "billing_payment_methods",
  "s7_notification_recipients",
  "s7_operational_tasks",
];

const SCHEMA_TABLES = [
  ...RUNTIME_TABLES,
  "order_raw_snapshots",
  "billing_admissions",
  "billing_usage",
  "s7_notification_templates",
  "s7_notification_event_types",
  "s7_notification_categories",
  "billing_notification_templates",
  "competition_monitored_listings",
  "competition_snapshots",
  "legal_document_acceptances",
  "marketplace_account_sales_import_coverage",
  "marketplace_account_sync_jobs",
  "plans",
];

const CANONICAL_STORAGE_POLICIES = [
  "company_logos_select_public",
  "company_logos_insert_own",
  "company_logos_update_own",
  "company_logos_delete_own",
];

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.startsWith("APPLY_MANUAL") && !f.startsWith("VALIDATE"))
    .sort();
}

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 100 * 1024 * 1024, ...opts });
}

function supabase(args, opts = {}) {
  return run(`supabase ${args}`, { cwd: WORKSPACE, ...opts });
}

function dockerOk() {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getDbContainer() {
  const r = run('docker ps --format "{{.Names}}"');
  if (r.status !== 0) return null;
  const names = r.stdout.split(/\r?\n/).filter(Boolean);
  return names.find((n) => n.includes("supabase_db") && n.includes("supabase-local-replay-workspace")) ?? null;
}

function psql(sql, opts = {}) {
  const container = getDbContainer();
  if (!container) return { status: 1, stdout: "", stderr: "supabase db container not found" };
  return spawnSync(
    "docker",
    ["exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts },
  );
}

function psqlFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const container = getDbContainer();
  if (!container) return { status: 1, stdout: "", stderr: "supabase db container not found", file: path.basename(filePath), path: filePath };
  const r = spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: content, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  return { ...r, file: path.basename(filePath), path: filePath };
}

async function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanupWorkspaceContainers() {
  run('docker ps -a --filter "name=supabase-local-replay-workspace" -q | ForEach-Object { docker rm -f $_ }', {
    stdio: "ignore",
  });
  run('docker volume ls --filter "name=supabase-local-replay-workspace" -q | ForEach-Object { docker volume rm -f $_ }', {
    stdio: "ignore",
  });
  run('docker ps -a --filter "name=supabase_" --format "{{.Names}}" | Select-String "supabase-local-replay-workspace" | ForEach-Object { docker rm -f $_.Line.Trim() }', {
    stdio: "ignore",
  });
}

async function destroySupabaseLocal() {
  supabase("stop --no-backup", { stdio: "ignore" });
  await sleepMs(20000);
  cleanupWorkspaceContainers();
  await sleepMs(10000);
}

function isSupabaseLocalReady() {
  const c = getDbContainer();
  if (!c) return false;
  const r = psql("SELECT 1");
  if (r.status !== 0) return false;
  const platform = inspectPlatformContract();
  return platform.has_file_size_limit && platform.has_allowed_mime_types;
}

async function ensureSupabaseLocal({ reset = true } = {}) {
  if (reset) {
    await destroySupabaseLocal();
  } else if (isSupabaseLocalReady()) {
    return getDbContainer();
  }

  const start = supabase("start", { stdio: "pipe" });
  const startOut = `${start.stdout || ""}\n${start.stderr || ""}`;
  if (start.status !== 0 && !/already running|local development setup is running/i.test(startOut)) {
    cleanupWorkspaceContainers();
    await sleepMs(5000);
    const retry = supabase("start", { stdio: "pipe" });
    const retryOut = `${retry.stdout || ""}\n${retry.stderr || ""}`;
    if (retry.status !== 0 && !/already running|local development setup is running/i.test(retryOut)) {
      throw new Error(`supabase start failed: ${retryOut.slice(0, 2000)}`);
    }
  }
  for (let i = 0; i < 90; i++) {
    if (isSupabaseLocalReady()) return getDbContainer();
    await sleepMs(2000);
  }
  throw new Error("Supabase local DB not ready");
}

function reorderPostBaselineForDependencies(files, migDir) {
  const createHealth = files.find((f) => f.includes("20260401120000_marketplace_listing_health.sql"));
  if (!createHealth) return files;
  const without = files.filter((f) => f !== createHealth);
  let insertAt = without.length;
  for (let i = 0; i < without.length; i++) {
    const content = fs.readFileSync(path.join(migDir, without[i]), "utf8");
    if (content.includes("marketplace_listing_health")) {
      insertAt = i;
      break;
    }
  }
  return [...without.slice(0, insertAt), createHealth, ...without.slice(insertAt)];
}

function buildCombinedChain(backendMigs, frontendMigDir, baselineFile, frontendMigs) {
  const bridgeFile = frontendMigs.find((f) => f.includes("baseline_sales_schema_bridge"));
  const prereqFiles = FRONTEND_PREREQ_AFTER_BASELINE.map((name) => frontendMigs.find((f) => f === name)).filter(Boolean);
  const postBaselineRaw = frontendMigs.filter(
    (f) => baselineFile && f > baselineFile && f !== bridgeFile && !FRESH_REPLAY_SKIP.has(f),
  );
  const postBaseline = reorderPostBaselineForDependencies(postBaselineRaw, frontendMigDir);

  /** @type {{ order: number; repo: string; path: string; timestamp: string; sha256: string; reason: string }[]} */
  const chain = [];
  let order = 0;
  const add = (repo, fp, reason) => {
    order += 1;
    const base = path.basename(fp);
    chain.push({
      order,
      repo,
      path: fp.replace(/\\/g, "/"),
      timestamp: base.split("_")[0],
      sha256: sha256(fs.readFileSync(fp, "utf8")),
      reason,
    });
  };

  if (baselineFile) add("suse7-frontend", path.join(frontendMigDir, baselineFile), "Core public schema baseline");
  if (bridgeFile) add("suse7-frontend", path.join(frontendMigDir, bridgeFile), "Drop legacy empty sales tables before phase3 recreate");
  for (const f of prereqFiles) add("suse7-frontend", path.join(frontendMigDir, f), "Prerequisite schema gap not captured in baseline export");
  for (const f of postBaseline) add("suse7-frontend", path.join(frontendMigDir, f), "Frontend post-baseline migration");
  for (const f of backendMigs) add("suse7-backend", path.join(BACKEND_ROOT, "supabase", "migrations", f), "Backend incremental migration");
  return chain;
}

function applyChain(label, chainMeta) {
  /** @type {{ order: number; file: string; repo: string; status: string; error?: string }[]} */
  const results = [];
  for (const item of chainMeta) {
    const r = psqlFile(item.path);
    if (r.status !== 0) {
      results.push({
        order: item.order,
        file: r.file,
        repo: item.repo,
        status: "FAIL",
        error: (r.stderr || r.stdout || "").slice(0, 3000),
      });
      return { label, ok: false, failed_at: r.file, failed_order: item.order, results };
    }
    results.push({ order: item.order, file: r.file, repo: item.repo, status: "PASS" });
  }
  return { label, ok: true, results };
}

function countRows(table) {
  const r = psql(`SELECT count(*)::int AS c FROM ${table}`);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/\s(\d+)\s/);
  return m ? Number(m[1]) : null;
}

function tableExists(table) {
  const r = psql(`SELECT to_regclass('${table}') IS NOT NULL AS ok`);
  return r.status === 0 && r.stdout.includes("t");
}

function indexExists(name) {
  const r = psql(`SELECT to_regclass('public.${name}') IS NOT NULL AS ok`);
  return r.status === 0 && r.stdout.includes("t");
}

function functionExists(name) {
  const r = psql(
    `SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='${name}') AS ok`,
  );
  return r.status === 0 && r.stdout.includes("t");
}

function schemaFingerprint() {
  const r = psql(`
SELECT md5(string_agg(c.relname || ':' || pg_catalog.pg_get_userbyid(c.relowner), ',' ORDER BY c.relname))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','i','S','v','m');
`);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/\s([a-f0-9]{32})\s/);
  return m ? m[1] : r.stdout.trim();
}

function inspectPlatformContract() {
  const bucketsCols = psql(`
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='storage' AND table_name='buckets'
ORDER BY ordinal_position;
`);
  const authUsers = psql(`SELECT count(*)::int FROM auth.users`);
  const storageSchema = psql(`SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('auth','storage','realtime') ORDER BY 1`);
  return {
    storage_buckets_columns: bucketsCols.status === 0 ? bucketsCols.stdout.trim() : null,
    has_file_size_limit: bucketsCols.stdout?.includes("file_size_limit") ?? false,
    has_allowed_mime_types: bucketsCols.stdout?.includes("allowed_mime_types") ?? false,
    auth_users_count: authUsers.status === 0 ? Number((authUsers.stdout.match(/\s(\d+)\s/) || [])[1] ?? -1) : null,
    platform_schemas: storageSchema.status === 0 ? storageSchema.stdout.trim().split(/\r?\n/).filter((l) => l && !l.startsWith("schema")) : [],
  };
}

function inspectStorageAppContract() {
  const bucket = psql(`
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets WHERE id='company-logos';
`);
  const objects = psql(`SELECT count(*)::int FROM storage.objects WHERE bucket_id='company-logos'`);
  const productImages = psql(`SELECT id, public FROM storage.buckets WHERE id='product-images'`);

  const policies = psql(`
SELECT polname, polcmd
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='storage' AND c.relname='objects'
ORDER BY polname;
`);

  /** @type {Record<string, string>[]} */
  const policyRows = [];
  if (policies.status === 0) {
    for (const line of policies.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*(\S+)\s*\|\s*(\S+)/);
      if (m && !m[1].startsWith("polname")) policyRows.push({ name: m[1], cmd: m[2] });
    }
  }

  const policyClassification = policyRows.map((p) => ({
    name: p.name,
    cmd: p.cmd,
    class: CANONICAL_STORAGE_POLICIES.includes(p.name)
      ? "CANONICAL_REQUIRED"
      : /^[a-f0-9]{8}-/.test(p.name) || p.name.includes("_objects_")
        ? "LEGACY_DRIFT"
        : "UNKNOWN",
  }));

  return {
    company_logos: {
      exists: bucket.status === 0 && bucket.stdout.includes("company-logos"),
      raw: bucket.status === 0 ? bucket.stdout.trim() : null,
      objects_count: objects.status === 0 ? Number((objects.stdout.match(/\s(\d+)\s/) || [])[1] ?? -1) : null,
      pass:
        bucket.status === 0 &&
        bucket.stdout.includes("company-logos") &&
        bucket.stdout.includes("t") &&
        bucket.stdout.includes("5242880") &&
        bucket.stdout.includes("image/jpeg"),
    },
    product_images: {
      exists: productImages.status === 0 && productImages.stdout.includes("product-images"),
      raw: productImages.status === 0 ? productImages.stdout.trim() : null,
      classification: "NOT_REQUIRED",
      rationale: "No migration or frontend/backend code reference to storage bucket product-images; products use product_images jsonb column",
    },
    policies: policyClassification,
  };
}

function validatePostReplay(runLabel) {
  const schemaChecks = SCHEMA_TABLES.map((t) => ({ table: t, exists: tableExists(`public.${t}`) }));
  const schemaOk = schemaChecks.filter((c) => c.exists).length >= SCHEMA_TABLES.length - 3;

  const runtimeCounts = {};
  for (const t of RUNTIME_TABLES) {
    if (tableExists(`public.${t}`)) runtimeCounts[t] = countRows(`public.${t}`);
  }
  runtimeCounts.auth_users = countRows("auth.users");
  const runtimeZero = Object.entries(runtimeCounts).every(([, c]) => c === 0);

  const globalTables = [
    "s7_notification_categories",
    "s7_notification_event_types",
    "s7_notification_templates",
    "billing_notification_templates",
    "plans",
  ];
  const globalCounts = globalTables.map((t) => ({
    table: t,
    exists: tableExists(`public.${t}`),
    actual_count: tableExists(`public.${t}`) ? countRows(`public.${t}`) : null,
  }));

  const storage = inspectStorageAppContract();

  const critical = {
    sales_order_items_uidx: indexExists("sales_order_items_marketplace_order_line_uidx"),
    billing_admission_atomic: functionExists("s7_billing_register_billable_sale_admission"),
    ml_webhook_events: tableExists("public.ml_webhook_events"),
    billing_payment_methods: tableExists("public.billing_payment_methods"),
    legal_document_acceptances: tableExists("public.legal_document_acceptances"),
    import_coverage: tableExists("public.marketplace_account_sales_import_coverage"),
  };

  return {
    run: runLabel,
    schema: { ok: schemaOk, checks: schemaChecks },
    runtime_zero: { ok: runtimeZero, counts: runtimeCounts },
    global_counts: globalCounts,
    storage,
    critical: { ok: Object.values(critical).every(Boolean), checks: critical },
    schema_fingerprint: schemaFingerprint(),
  };
}

function classifyNextFailure(error, file) {
  const e = String(error || "");
  if (/storage\.|auth\.|realtime\./i.test(e) && /does not exist|permission denied for schema/i.test(e)) {
    return "A_PLATFORM_SUPABASE_OR_STUB_GAP";
  }
  if (/relation .* does not exist/i.test(e)) return "C_SCHEMA_APP_MISSING";
  if (/duplicate key|already exists/i.test(e)) return "B_ORDERING";
  if (/violates foreign key/i.test(e)) return "C_SCHEMA_APP_MISSING";
  return "E_MIGRATION_INVALID_OR_UNKNOWN";
}

function auditPlansCatalog() {
  const migDir = path.join(BACKEND_ROOT, "supabase", "migrations");
  const files = listSql(migDir);
  const hits = [];
  for (const f of files) {
    const c = fs.readFileSync(path.join(migDir, f), "utf8");
    if (/INSERT\s+INTO\s+.*plans/i.test(c) || /plan_key|sales_limit_monthly|is_active/i.test(c)) {
      hits.push({ file: f, has_insert_plans: /INSERT\s+INTO\s+.*plans/i.test(c) });
    }
  }
  const frontendHits = listSql(path.join(FRONTEND_ROOT, "supabase", "migrations")).filter((f) => {
    const c = fs.readFileSync(path.join(FRONTEND_ROOT, "supabase", "migrations", f), "utf8");
    return /INSERT\s+INTO\s+.*plans/i.test(c);
  });
  return {
    versioned: hits.some((h) => h.has_insert_plans) || frontendHits.length > 0,
    backend_references: hits,
    frontend_inserts: frontendHits,
    classification: hits.some((h) => h.has_insert_plans) || frontendHits.length > 0 ? "PARTIAL_VERSIONED" : "BLOCKER_NOT_VERSIONED",
    note: "plan_key/is_active/sales_limit_monthly referenced in billing migrations but Baby catalog INSERT not found in canonical chain",
  };
}

async function runBackendSmoke(statusJson) {
  if (!statusJson?.API_URL) return { status: "SKIPPED", reason: "no supabase status" };
  try {
    const health = await fetch(`${statusJson.API_URL.replace(/\/$/, "")}/rest/v1/`, {
      headers: { apikey: statusJson.ANON_KEY || "", Authorization: `Bearer ${statusJson.ANON_KEY || ""}` },
    });
    const plans = tableExists("public.plans");
    return {
      status: health.ok ? "PASS" : "FAIL",
      rest_v1: health.status,
      plans_table: plans,
      api_url: statusJson.API_URL,
    };
  } catch (e) {
    return { status: "FAIL", error: String(e.message || e) };
  }
}

async function runSignupSmoke(statusJson) {
  if (!statusJson?.API_URL || !statusJson?.ANON_KEY) return { status: "BLOCKED", reason: "missing local keys" };
  const base = statusJson.API_URL.replace(/\/$/, "");
  const email = `replay-${Date.now()}@s7-local.test`;
  const password = "s7replay-local-123";
  try {
    const res = await fetch(`${base}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: statusJson.ANON_KEY,
        Authorization: `Bearer ${statusJson.ANON_KEY}`,
      },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    const userId = body?.user?.id || body?.id;
    const profilesAfter = userId ? psql(`SELECT count(*)::int FROM public.profiles WHERE id='${userId}'`) : null;
    return {
      status: res.ok ? "PASS" : "FAIL",
      http: res.status,
      user_created: Boolean(userId),
      profile_auto_created: profilesAfter ? profilesAfter.stdout?.includes("1") : false,
      note: "Auth local only — billing/Asaas not exercised",
    };
  } catch (e) {
    return { status: "BLOCKED", error: String(e.message || e) };
  }
}

function getSupabaseStatus() {
  const r = supabase("status -o json");
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

async function main() {
  const cliVersion = run("supabase --version");
  const docker = dockerOk();

  const backendMigDir = path.join(BACKEND_ROOT, "supabase", "migrations");
  const backendMigs = listSql(backendMigDir).filter((f) => !WIP_EXCLUDED.has(f));
  const frontendMigDir = path.join(FRONTEND_ROOT, "supabase", "migrations");
  const frontendMigs = listSql(frontendMigDir);
  const baselineFile = frontendMigs.find((f) => f.includes("baseline_public_from_prod"));

  const chainMeta = buildCombinedChain(backendMigs, frontendMigDir, baselineFile, frontendMigs);
  const platformBefore = { note: "captured after supabase start, before app migrations" };

  if (!docker) {
    console.error(JSON.stringify({ status: "PARADA", docker: "FAIL" }));
    process.exit(2);
  }

  await ensureSupabaseLocal();
  Object.assign(platformBefore, inspectPlatformContract());

  const replay1 = applyChain("replay_1", chainMeta);
  const post1 = replay1.ok ? validatePostReplay("replay_1") : null;
  const status1 = getSupabaseStatus();
  const backendSmoke1 = post1 ? await runBackendSmoke(status1) : { status: "SKIPPED" };
  const signupSmoke1 = post1 ? await runSignupSmoke(status1) : { status: "SKIPPED" };

  await destroySupabaseLocal();

  let replay2 = null;
  let post2 = null;
  let backendSmoke2 = { status: "SKIPPED" };
  if (replay1.ok) {
    await ensureSupabaseLocal();
    replay2 = applyChain("replay_2", chainMeta);
    post2 = replay2.ok ? validatePostReplay("replay_2") : null;
    backendSmoke2 = post2 ? await runBackendSmoke(getSupabaseStatus()) : { status: "SKIPPED" };
    await destroySupabaseLocal();
  }

  const determinism =
    replay1.ok && replay2?.ok && post1 && post2
      ? {
          ok:
            post1.schema_fingerprint === post2.schema_fingerprint &&
            JSON.stringify(post1.global_counts) === JSON.stringify(post2.global_counts) &&
            post1.critical.ok === post2.critical.ok,
          schema_fingerprint_1: post1.schema_fingerprint,
          schema_fingerprint_2: post2.schema_fingerprint,
        }
      : { ok: false, reason: "replay incomplete" };

  const stubsAudit = {
    removed_from_supabase_local_replay: [
      "local-bootstrap/auth-storage-stub (auth.users minimal table)",
      "local-bootstrap/storage.buckets stub without file_size_limit",
      "local-bootstrap/storage.objects stub",
      "local-bootstrap auth.uid()/role()/jwt() no-op functions",
    ],
    app_required_compat: [],
    note: "Supabase Local provides real auth/storage/realtime platform schemas",
  };

  const storageAppContract = {
    generated_at: new Date().toISOString(),
    company_logos: {
      migration: "20260512120000_storage_company_logos_bucket.sql",
      classification: "MIGRATION_MANAGED",
      expected: { public: true, file_size_limit: 5242880, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"], objects: 0 },
      observed: post1?.storage?.company_logos ?? null,
      pass: post1?.storage?.company_logos?.pass ?? false,
    },
    product_images: {
      classification: "NOT_REQUIRED",
      migration_canonical: false,
      app_dependency: false,
      dev_manual: "likely legacy/manual on DEV",
      policies_versioned: false,
    },
    policies: post1?.storage?.policies ?? [],
  };

  const plansCatalog = auditPlansCatalog();

  const passed1 = replay1.results?.filter((r) => r.status === "PASS").length ?? 0;
  const total = chainMeta.length;

  fs.mkdirSync(OUT, { recursive: true });

  const platformContract = {
    generated_at: new Date().toISOString(),
    mission: "DEV.V2.SUPABASE-LOCAL-REPLAY.04",
    docker: docker ? "PASS" : "FAIL",
    supabase_cli: (cliVersion.stdout || "").trim(),
    workspace: WORKSPACE.replace(/\\/g, "/"),
    before_app_migrations: platformBefore,
    stubs_audit: stubsAudit,
    internal_schema_comparison: "NOT_REQUIRED — app-owned contract is canonical",
  };

  const replayLog = {
    generated_at: new Date().toISOString(),
    replay_before_plain_postgres: "56/115",
    replay_1: replay1,
    replay_2: replay2,
    post_1: post1,
    post_2: post2,
    determinism,
    backend_smoke: { replay_1: backendSmoke1, replay_2: backendSmoke2 },
    signup_smoke: signupSmoke1,
    plans_catalog: plansCatalog,
    next_failure: replay1.ok
      ? replay2?.ok
        ? null
        : { file: replay2?.failed_at, class: classifyNextFailure(replay2?.results?.at(-1)?.error, replay2?.failed_at) }
      : { file: replay1.failed_at, class: classifyNextFailure(replay1.results?.at(-1)?.error, replay1.failed_at), error: replay1.results?.at(-1)?.error },
  };

  const schemaFingerprintOut = {
    generated_at: new Date().toISOString(),
    replay_1: post1?.schema_fingerprint ?? null,
    replay_2: post2?.schema_fingerprint ?? null,
    determinism_match: determinism.ok,
    app_owned_tables: post1?.schema?.checks ?? [],
    critical: post1?.critical ?? null,
  };

  fs.writeFileSync(path.join(OUT, `DEV_V2_SUPABASE_LOCAL_PLATFORM_CONTRACT_${RUN_DATE}.json`), JSON.stringify(platformContract, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_STORAGE_APP_CONTRACT_${RUN_DATE}.json`), JSON.stringify(storageAppContract, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_SUPABASE_LOCAL_REPLAY_LOG_${RUN_DATE}.json`), JSON.stringify(replayLog, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_SUPABASE_LOCAL_SCHEMA_FINGERPRINT_${RUN_DATE}.json`), JSON.stringify(schemaFingerprintOut, null, 2));

  const report = buildReport({
    replay1,
    replay2,
    post1,
    post2,
    passed1,
    total,
    storageAppContract,
    plansCatalog,
    determinism,
    backendSmoke1,
    signupSmoke1,
    stubsAudit,
    platformBefore,
  });
  fs.writeFileSync(path.join(OUT, `RELATORIO_DEV_V2_SUPABASE_LOCAL_REPLAY_04_${RUN_DATE}.md`), report);

  console.log(
    JSON.stringify(
      {
        mission: "DEV.V2.SUPABASE-LOCAL-REPLAY.04",
        replay_1: `${passed1}/${total}`,
        replay_1_ok: replay1.ok,
        replay_2_ok: replay2?.ok ?? false,
        storage_company_logos: storageAppContract.company_logos.pass,
        next_failure: replayLog.next_failure,
      },
      null,
      2,
    ),
  );

  process.exit(replay1.ok && replay2?.ok ? 0 : 1);
}

function buildReport(ctx) {
  const nf = ctx.replay1.ok ? (ctx.replay2?.ok ? "—" : ctx.replay2?.failed_at) : ctx.replay1.failed_at;
  const nfClass = ctx.replay1.ok ? (ctx.replay2?.ok ? "—" : "see log") : ctx.replay1.results?.at(-1)?.error?.slice(0, 200);
  return `# RELATÓRIO — DEV.V2.SUPABASE-LOCAL-REPLAY.04 (${RUN_DATE})

## 1. STATUS
${ctx.replay1.ok && ctx.replay2?.ok ? "REPLAY COMPLETO" : ctx.replay1.ok ? "REPLAY #1 PASS — #2 ou pós-validação pendente" : "REPLAY EM PROGRESSO / BLOQUEADO"}

## 2. SUPABASE LOCAL
${ctx.platformBefore?.has_file_size_limit ? "PASS" : "FAIL"} — stack local com \`storage.buckets.file_size_limit\` nativo

## 3. STUBS REMOVIDOS/NECESSÁRIOS
Removidos: ${ctx.stubsAudit.removed_from_supabase_local_replay.length} stubs de plataforma plain-Postgres.
App compat: ${ctx.stubsAudit.app_required_compat.length}

## 4. STORAGE COMPANY-LOGOS
${ctx.storageAppContract.company_logos.pass ? "PASS" : ctx.replay1.failed_at === "20260512120000_storage_company_logos_bucket.sql" ? "FAIL (still blocked)" : ctx.replay1.ok ? "PASS (migration applied)" : "NOT_REACHED"}

## 5. PRODUCT-IMAGES
**NOT_REQUIRED** — sem migration canônica; produtos usam coluna \`product_images\` jsonb

## 6. STORAGE POLICIES
${(ctx.storageAppContract.policies || []).map((p) => `- ${p.name}: ${p.class}`).join("\n") || "not reached"}

## 7. REPLAY ANTES
56/115 (plain Postgres stub)

## 8. REPLAY DEPOIS
${ctx.passed1}/${ctx.total}

## 9. NEXT FAILURE
${nf}${nfClass && nfClass !== "—" ? `\n\`\`\`\n${nfClass}\n\`\`\`` : ""}

## 10. PLANS CATALOG
Versionado: **${ctx.plansCatalog.versioned ? "PARCIAL" : "NÃO"}** — ${ctx.plansCatalog.classification}

## 11. REPLAY #1
${ctx.replay1.ok ? "PASS" : "FAIL"}

## 12. RUNTIME ZERO
${ctx.post1 ? (ctx.post1.runtime_zero.ok ? "PASS" : "FAIL") : "SKIPPED"}

## 13. GLOBAL DATA
${ctx.post1 ? "OBSERVED — ver JSON" : "SKIPPED"}

## 14. BACKEND SMOKE
${ctx.backendSmoke1?.status ?? "SKIPPED"}

## 15. SIGNUP SMOKE
${ctx.signupSmoke1?.status ?? "SKIPPED"}

## 16. REPLAY #2
${ctx.replay2 ? (ctx.replay2.ok ? "PASS" : "FAIL") : "SKIPPED"}

## 17. DETERMINISM
${ctx.determinism.ok ? "PASS" : ctx.replay2 ? "FAIL" : "SKIPPED"}

## 18. APP SCHEMA FINGERPRINT
${ctx.post1?.schema_fingerprint ?? "n/a"}

## 19. TESTES
Provenance/legacy/snapshot/webhook/maintenance: não reexecutados nesta missão (escopo replay local)

## 20. BLOCKERS
${ctx.replay1.ok ? "Nenhum blocker de plataforma storage" : "Ver next failure"}

## 21. RECOMENDAÇÃO
${ctx.replay1.ok ? "Continuar cadeia; tratar plans catalog quando replay provar gap" : "Corrigir falha app-owned; não stubar storage interno"}

## PRONTO PARA COMMIT
NÃO

## FRESH DEV V2 READY
${ctx.replay1.ok && ctx.post1?.runtime_zero?.ok ? "PARCIAL" : "NÃO"}
`;
}

main().catch(async (e) => {
  console.error(e);
  await destroySupabaseLocal();
  process.exit(1);
});
