#!/usr/bin/env node
/**
 * DEV.V2.HOSTED-FOUNDATION-CREATE.10
 * Cria/aplica cadeia canônica 116 migrations em Supabase hosted fresh.
 * NÃO altera DEV V1, PROD, Vercel, OAuth, Asaas.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";
const CLEAN_BACKEND = process.env.CLEAN_BACKEND_ROOT || path.join(__dirname, "..");
const CLEAN_FRONTEND = process.env.CLEAN_FRONTEND_ROOT || path.join(CLEAN_BACKEND, "..", "suse7-frontend");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const SECRETS_FILE = path.join(OUT, ".dev_v2_hosted_secrets.local");
const PROJECT_NAME = process.env.DEV_V2_PROJECT_NAME || "Suse7-dev-v2-foundation";
const ORG_ID = "qanxmrjxuynxkzrehxys";
const REGION = process.env.DEV_V2_REGION || "us-east-1";
const EXPECTED_FRONTEND_HASH = "cae8ee731c19997f9bed57ce22d8e0f6b19c7148";
const EXPECTED_BACKEND_HASH = "c236b391c6201457de7755fc60df2ddf7b4f601f";
const LOCAL_SCHEMA_FINGERPRINT = "375f7a55afe401876871936ed8fb54b8";
const DEV_V1_REF = "ujznkyvgqhxagemdgmor";
const PROD_REF = "bazibzquasbdgjwdcwbz";

const FRESH_REPLAY_SKIP = new Set(["20260327150100_sale_fee_coherence_backfill.sql"]);
const WIP_EXCLUDED = new Set([
  "20260810200000_marketplace_listings_sku_dependency_pending_idx.sql",
  "20260812120000_s7_primary_company_default_recipient.sql",
]);
const FRONTEND_PREREQ_AFTER_BASELINE = ["20260217000000_normalized_sku_unique.sql"];
const RUNTIME_TABLES = [
  "profiles", "seller_companies", "marketplace_accounts", "ml_tokens", "products",
  "marketplace_listings", "sales_orders", "sales_order_items", "ml_webhook_events",
  "billing_subscriptions", "billing_customers", "billing_payment_methods",
  "s7_notification_recipients", "s7_operational_tasks", "billing_admissions",
  "billing_usage", "competition_monitored_listings", "competition_snapshots",
  "legal_document_acceptances", "marketplace_account_sync_jobs",
];
const GLOBAL_TABLES = [
  "s7_notification_categories", "s7_notification_event_types", "s7_notification_templates",
  "billing_notification_templates", "plans",
];
const EXPECTED_GLOBAL = {
  s7_notification_categories: 11,
  s7_notification_event_types: 31,
  s7_notification_templates: 36,
  billing_notification_templates: 11,
  plans: 8,
};
const CANONICAL_STORAGE_POLICIES = [
  "company_logos_select_public", "company_logos_insert_own",
  "company_logos_update_own", "company_logos_delete_own",
];

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 100 * 1024 * 1024, ...opts });
}

function supabase(args, opts = {}) {
  return run(`supabase ${args}`, opts);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.startsWith("APPLY_MANUAL")).sort();
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

function buildCombinedChain() {
  const backendMigDir = path.join(CLEAN_BACKEND, "supabase", "migrations");
  const frontendMigDir = path.join(CLEAN_FRONTEND, "supabase", "migrations");
  const backendMigs = listSql(backendMigDir).filter((f) => !WIP_EXCLUDED.has(f));
  const frontendMigs = listSql(frontendMigDir);
  const baselineFile = frontendMigs.find((f) => f.includes("baseline_public_from_prod"));
  const bridgeFile = frontendMigs.find((f) => f.includes("baseline_sales_schema_bridge"));
  const prereqFiles = FRONTEND_PREREQ_AFTER_BASELINE.map((n) => frontendMigs.find((f) => f === n)).filter(Boolean);
  const postBaselineRaw = frontendMigs.filter(
    (f) => baselineFile && f > baselineFile && f !== bridgeFile && !FRESH_REPLAY_SKIP.has(f),
  );
  const postBaseline = reorderPostBaselineForDependencies(postBaselineRaw, frontendMigDir);
  /** @type {{ order: number; repo: string; path: string; file: string; sha256: string }[]} */
  const chain = [];
  let order = 0;
  const add = (repo, fp) => {
    order += 1;
    chain.push({
      order,
      repo,
      path: fp,
      file: path.basename(fp),
      sha256: sha256(fs.readFileSync(fp, "utf8")),
    });
  };
  if (baselineFile) add("suse7-frontend", path.join(frontendMigDir, baselineFile));
  if (bridgeFile) add("suse7-frontend", path.join(frontendMigDir, bridgeFile));
  for (const f of prereqFiles) add("suse7-frontend", path.join(frontendMigDir, f));
  for (const f of postBaseline) add("suse7-frontend", path.join(frontendMigDir, f));
  for (const f of backendMigs) add("suse7-backend", path.join(backendMigDir, f));
  return chain;
}

function verifyGitHashes() {
  const fe = run(`git -C "${CLEAN_FRONTEND}" rev-parse HEAD`).stdout.trim();
  const be = run(`git -C "${CLEAN_BACKEND}" rev-parse HEAD`).stdout.trim();
  run(`git -C "${CLEAN_FRONTEND}" fetch origin`);
  run(`git -C "${CLEAN_BACKEND}" fetch origin`);
  const feRemote = run(`git -C "${CLEAN_FRONTEND}" rev-parse origin/recovery/surgical-pre-permissions-regression`).stdout.trim();
  const beRemote = run(`git -C "${CLEAN_BACKEND}" rev-parse origin/rc/asaas-notification-cost-guard-1`).stdout.trim();
  return {
    pass: fe === EXPECTED_FRONTEND_HASH && be === EXPECTED_BACKEND_HASH && fe === feRemote && be === beRemote,
    frontend: { local: fe, remote: feRemote, expected: EXPECTED_FRONTEND_HASH },
    backend: { local: be, remote: beRemote, expected: EXPECTED_BACKEND_HASH },
  };
}

function loadOrCreateSecrets() {
  if (fs.existsSync(SECRETS_FILE)) {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  }
  const dbPassword = crypto.randomBytes(24).toString("base64url");
  const create = supabase(
    `projects create "${PROJECT_NAME}" --org-id ${ORG_ID} --region ${REGION} --db-password "${dbPassword}" -o json`,
  );
  const jsonMatch = create.stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`project create failed: ${create.stderr || create.stdout}`);
  const project = parseSupabaseJson(create.stdout) || JSON.parse(jsonMatch[0]);
  const secrets = {
    project_ref: project.ref || project.id,
    project_name: project.name,
    region: project.region || REGION,
    created_at: project.created_at || new Date().toISOString(),
    db_password: dbPassword,
    anon_key: "CONFIGURED_LATER",
    service_role_key: "CONFIGURED_LATER",
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

function parseSupabaseJson(stdout) {
  const start = stdout.indexOf("[");
  const startObj = stdout.indexOf("{");
  let idx = -1;
  if (start >= 0 && (startObj < 0 || start < startObj)) idx = start;
  else if (startObj >= 0) idx = startObj;
  if (idx < 0) return null;
  const slice = stdout.slice(idx);
  const endArr = slice.lastIndexOf("]");
  const endObj = slice.lastIndexOf("}");
  const end = endArr > endObj ? endArr : endObj;
  if (end < 0) return null;
  try {
    return JSON.parse(slice.slice(0, end + 1));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForProjectActive(projectRef, maxMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = supabase("projects list -o json");
    const projects = parseSupabaseJson(`${r.stdout}\n${r.stderr}`);
    const list = Array.isArray(projects) ? projects : projects?.projects ?? [];
    const p = list.find((x) => x.ref === projectRef || x.id === projectRef);
    if (p && (p.status === "ACTIVE_HEALTHY" || p.status === "ACTIVE")) return p;
    await sleep(15000);
  }
  throw new Error(`project ${projectRef} not ACTIVE within timeout`);
}

function prepareWorkspaceMigrations(chain) {
  const migDir = path.join(WORKSPACE, "supabase", "migrations");
  fs.rmSync(migDir, { recursive: true, force: true });
  fs.mkdirSync(migDir, { recursive: true });
  if (!fs.existsSync(path.join(WORKSPACE, "supabase", "config.toml"))) {
    fs.mkdirSync(path.join(WORKSPACE, "supabase"), { recursive: true });
    fs.writeFileSync(
      path.join(WORKSPACE, "supabase", "config.toml"),
      'project_id = "supabase-hosted-v2-workspace"\n',
    );
  }
  let baseTs = 20260301000000;
  for (const item of chain) {
    baseTs += 1;
    const dest = path.join(migDir, `${baseTs}_${item.file.replace(/^\d+_/, "")}`);
    fs.copyFileSync(item.path, dest);
  }
  return migDir;
}

function supabaseArgs(args, opts = {}) {
  return spawnSync("supabase", args, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    shell: false,
    ...opts,
  });
}

function pushMigrations(projectRef, dbPassword) {
  const link = supabaseArgs(["link", "--project-ref", projectRef, "-p", dbPassword, "--yes"], { cwd: WORKSPACE });
  if (link.status !== 0 && !/already linked/i.test(`${link.stdout}\n${link.stderr}`)) {
    throw new Error(`link failed: ${link.stderr || link.stdout}`);
  }
  const push = supabaseArgs(["db", "push", "--linked", "-p", dbPassword, "--yes"], { cwd: WORKSPACE });
  return { link, push, ok: push.status === 0, output: (push.stdout || "") + (push.stderr || "") };
}

function psqlRemote(sql, projectRef, dbPassword) {
  const host = `db.${projectRef}.supabase.co`;
  const conn = `postgresql://postgres:${encodeURIComponent(dbPassword)}@${host}:5432/postgres`;
  const r = spawnSync(
    "docker",
    ["run", "--rm", "postgres:17", "psql", conn, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  return r;
}

function countRows(table, projectRef, dbPassword) {
  const r = psqlRemote(`SELECT count(*)::int FROM ${table}`, projectRef, dbPassword);
  if (r.status !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function tableExists(table, projectRef, dbPassword) {
  const r = psqlRemote(`SELECT to_regclass('${table}') IS NOT NULL`, projectRef, dbPassword);
  return r.status === 0 && r.stdout.trim() === "t";
}

function schemaFingerprint(projectRef, dbPassword) {
  const r = psqlRemote(`
SELECT md5(string_agg(c.relname || ':' || pg_catalog.pg_get_userbyid(c.relowner), ',' ORDER BY c.relname))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','i','S','v','m');
`, projectRef, dbPassword);
  return r.status === 0 ? r.stdout.trim() : null;
}

function validateHosted(projectRef, dbPassword) {
  const runtimeCounts = {};
  for (const t of RUNTIME_TABLES) {
    if (tableExists(`public.${t}`, projectRef, dbPassword)) {
      runtimeCounts[t] = countRows(`public.${t}`, projectRef, dbPassword);
    }
  }
  runtimeCounts.auth_users = countRows("auth.users", projectRef, dbPassword);

  const globalCounts = {};
  for (const t of GLOBAL_TABLES) {
    globalCounts[t] = tableExists(`public.${t}`, projectRef, dbPassword)
      ? countRows(`public.${t}`, projectRef, dbPassword)
      : null;
  }

  const bucket = psqlRemote(
    `SELECT id, public, file_size_limit::text, allowed_mime_types::text FROM storage.buckets WHERE id='company-logos'`,
    projectRef,
    dbPassword,
  );
  const objects = countRows("storage.objects WHERE bucket_id='company-logos'", projectRef, dbPassword);

  const plansBaby = psqlRemote(
    `SELECT plan_key, sales_limit_monthly::text, price_cents::text FROM public.plans WHERE plan_key='baby' LIMIT 1`,
    projectRef,
    dbPassword,
  );

  const constraints = {
    plans_count_8: globalCounts.plans === 8,
    plans_pk_name: psqlRemote(`SELECT COUNT(*)=0 FROM pg_constraint WHERE conrelid='public.plans'::regclass AND contype='p' AND conname LIKE '%name%' OR conrelid='public.plans'::regclass AND contype='p'`, projectRef, dbPassword).stdout.trim(),
    sales_order_items_uidx: psqlRemote(`SELECT to_regclass('public.sales_order_items_marketplace_order_line_uidx') IS NOT NULL`, projectRef, dbPassword).stdout.trim() === "t",
    billing_admission_fn: psqlRemote(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='s7_billing_register_billable_sale_admission')`, projectRef, dbPassword).stdout.trim() === "t",
  };

  const runtimeZero = Object.entries(runtimeCounts).every(([, c]) => c === 0);
  const globalOk = Object.entries(EXPECTED_GLOBAL).every(([t, exp]) => globalCounts[t] === exp);
  const fp = schemaFingerprint(projectRef, dbPassword);
  const storageOk =
    bucket.status === 0 &&
    bucket.stdout.includes("company-logos") &&
    bucket.stdout.includes("t") &&
    bucket.stdout.includes("5242880") &&
    objects === 0;

  return {
    runtime_counts: runtimeCounts,
    runtime_zero: runtimeZero,
    global_counts: globalCounts,
    global_ok: globalOk,
    schema_fingerprint: fp,
    schema_fingerprint_match_local: fp === LOCAL_SCHEMA_FINGERPRINT,
    storage: { bucket: bucket.stdout?.trim(), objects_count: objects, pass: storageOk },
    plans_baby: plansBaby.stdout?.trim(),
    constraints,
    pass: runtimeZero && globalOk && storageOk && globalCounts.plans === 8,
  };
}

function fetchApiKeys(projectRef) {
  const r = supabase(`projects api-keys --project-ref ${projectRef} -o json`);
  const data = parseSupabaseJson(`${r.stdout}\n${r.stderr}`);
  const keys = Array.isArray(data) ? data : data?.keys ?? [];
  const anon = keys.find((k) => k.name === "anon" || k.name === "anon key");
  const service = keys.find((k) => k.name === "service_role" || k.name === "service_role key");
  return {
    anon: anon?.api_key ? "CONFIGURED" : "NOT_CONFIGURED",
    service_role: service?.api_key ? "CONFIGURED" : "NOT_CONFIGURED",
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const git = verifyGitHashes();
  if (!git.pass) {
    console.error(JSON.stringify({ status: "PARADA", reason: "git hash mismatch", git }, null, 2));
    process.exit(2);
  }

  let secrets = loadOrCreateSecrets();
  if (process.env.DEV_V2_PROJECT_REF) {
    secrets.project_ref = process.env.DEV_V2_PROJECT_REF;
  }
  if (process.env.DEV_V2_DB_PASSWORD) {
    secrets.db_password = process.env.DEV_V2_DB_PASSWORD;
  }

  await waitForProjectActive(secrets.project_ref);
  const chain = buildCombinedChain();
  prepareWorkspaceMigrations(chain);
  const migrationFingerprint = sha256(chain.map((c) => `${c.order}:${c.sha256}`).join("\n"));

  let push = { ok: true, output: "skipped DEV_V2_SKIP_PUSH=1" };
  if (process.env.DEV_V2_SKIP_PUSH !== "1") {
    push = pushMigrations(secrets.project_ref, secrets.db_password);
    if (!push.ok) {
      fs.writeFileSync(path.join(OUT, `DEV_V2_HOSTED_MIGRATION_RESULT_${RUN_DATE}.json`), JSON.stringify({ pass: false, push: push.output.slice(0, 5000), chain_length: chain.length }, null, 2));
      console.error(JSON.stringify({ status: "PARADA", step: "db_push", push: push.output.slice(0, 3000) }, null, 2));
      process.exit(1);
    }
  }

  const validation = validateHosted(secrets.project_ref, secrets.db_password);
  const apiKeys = fetchApiKeys(secrets.project_ref);

  const identity = {
    project_name: secrets.project_name || PROJECT_NAME,
    project_ref: secrets.project_ref,
    region: secrets.region,
    created_at: secrets.created_at,
    dev_v1_ref: DEV_V1_REF,
    dev_v1_touched: false,
    prod_ref: PROD_REF,
    prod_touched: false,
    region_decision: {
      dev_v1: "West US (Oregon)",
      prod: "East US (Ohio)",
      dev_v2: REGION,
      reason: "DEV V2 em us-east-1 para aproximar topologia PROD (East US) sem alterar PROD",
    },
    api_keys: apiKeys,
    db_password: "CONFIGURED",
  };

  fs.writeFileSync(path.join(OUT, `DEV_V2_HOSTED_IDENTITY_${RUN_DATE}.json`), JSON.stringify(identity, null, 2));
  fs.writeFileSync(
    path.join(OUT, `DEV_V2_HOSTED_MIGRATION_RESULT_${RUN_DATE}.json`),
    JSON.stringify({
      pass: true,
      migrations_applied: `${chain.length}/${chain.length}`,
      migration_fingerprint: migrationFingerprint,
      push_output_tail: push.output.slice(-2000),
      chain_files: chain.map((c) => c.file),
    }, null, 2),
  );
  fs.writeFileSync(path.join(OUT, `DEV_V2_HOSTED_RUNTIME_ZERO_${RUN_DATE}.json`), JSON.stringify(validation, null, 2));
  fs.writeFileSync(
    path.join(OUT, `DEV_V2_HOSTED_GLOBAL_REFERENCE_BASELINE_${RUN_DATE}.json`),
    JSON.stringify({ expected: EXPECTED_GLOBAL, observed: validation.global_counts, pass: validation.global_ok }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `DEV_V2_HOSTED_APP_SCHEMA_FINGERPRINT_${RUN_DATE}.json`),
    JSON.stringify({
      hosted: validation.schema_fingerprint,
      local_homologated: LOCAL_SCHEMA_FINGERPRINT,
      match: validation.schema_fingerprint_match_local,
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `DEV_V2_HOSTED_PROJECT_SETTINGS_GAP_${RUN_DATE}.json`),
    JSON.stringify({
      configured_now: ["database_migrations", "storage_company_logos_bucket"],
      required_before_app_connect: ["SUPABASE_URL", "anon_key", "service_role_key", "S7_EXPECTED_SUPABASE_PROJECT_REF"],
      required_before_oauth: ["ML OAuth callback", "ML webhook URL"],
      required_before_billing: ["Asaas webhook", "billing cron"],
      not_configured: ["Vercel env", "ML OAuth", "Asaas", "external cron", "signup customer"],
      external_writers_pointing_to_v2: 0,
    }, null, 2),
  );

  console.log(
    JSON.stringify(
      {
        mission: "DEV.V2.HOSTED-FOUNDATION-CREATE.10",
        project_ref: secrets.project_ref,
        migrations: `${chain.length}/${chain.length}`,
        validation_pass: validation.pass,
        runtime_zero: validation.runtime_zero,
        schema_fingerprint_match: validation.schema_fingerprint_match_local,
      },
      null,
      2,
    ),
  );
  process.exit(validation.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
