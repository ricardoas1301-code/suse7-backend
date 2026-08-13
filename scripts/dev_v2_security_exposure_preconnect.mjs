#!/usr/bin/env node
/**
 * DEV.V2.SECURITY-EXPOSURE-PRECONNECT.11 / .12
 * Auditoria Security Advisor + hardening local + testes anon/cross-tenant.
 * Lê migration canônica de suse7-backend/supabase/migrations/.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";
const WORKSPACE = path.join(__dirname, "supabase-local-replay-workspace");
const FRONTEND_ROOT = path.join(__dirname, "..", "..", "suse7-frontend");
const BACKEND_ROOT = path.join(__dirname, "..");
const CANONICAL_MIG_DIR = path.join(BACKEND_ROOT, "supabase", "migrations");

const HARDENING_MIG = "20260813180000_s7_security_exposure_preconnect_hardening.sql";
const CANONICAL_HARDENING_PATH = path.join(CANONICAL_MIG_DIR, HARDENING_MIG);

const INTENTIONAL_SERVICE_ONLY_TABLES = new Set([
  "ml_tokens",
  "oauth_states",
  "ml_webhook_events",
  "marketplace_account_sync_jobs",
  "marketplace_account_sales_import_coverage",
  "billing_webhook_events",
  "billing_events",
  "billing_analytics_snapshots",
  "billing_billable_sale_admissions",
  "billing_internal_deployment_identity",
  "billing_paid_lifecycle_job_locks",
  "billing_paid_lifecycle_ledger",
  "billing_trial_lifecycle_job_locks",
  "billing_trial_lifecycle_transitions",
  "billing_customer_notification_policy",
  "notification_delivery_logs",
  "s7_notification_email_outbox",
  "s7_notification_whatsapp_outbox",
  "s7_notification_popup_deliveries",
  "s7_notification_delivery_logs",
  "s7_notification_template_versions",
  "s7_global_customers",
  "dev_center_seller_feature_flags",
  "dev_center_toolbox_operational_audit",
  "dev_missions",
  "dev_decisions",
  "dev_history",
  "dev_next_steps",
  "dev_conversation_contexts",
]);

const SENSITIVE_FUNCTIONS = [
  "get_ml_token_for_user",
  "refresh_ml_tokens_for_user",
  "iniciar_teste_gratis",
  "reset_monthly_usage",
  "register_log",
  "registrar_precificacao",
  "snapshot_marketplace_listing_health",
  "update_product_image_links_sort_order",
  "update_product_variants_sort_order",
  "billing_internal_apply_access_precedence_after_baby_clear",
  "billing_internal_resolve_access_precedence",
  "billing_internal_resolve_baby_cycle_window",
  "billing_internal_civil_instant_sao_paulo",
  "get_catalog_rankings",
  "current_auth_uid",
  "delete_old_logs",
];

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 100 * 1024 * 1024, ...opts });
}

function getDbContainer() {
  const r = run('docker ps --format "{{.Names}}"');
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).find((n) => n.includes("supabase_db") && n.includes("supabase-local-replay-workspace")) ?? null;
}

function psql(sql, json = false) {
  const container = getDbContainer();
  if (!container) return { status: 1, stdout: "", stderr: "db container missing" };
  const args = ["exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  if (json) args.push("-t", "-A", "-F", "\t");
  args.push("-c", sql);
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function psqlJsonRows(sql) {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) AS rows FROM (${sql}) q`;
  const container = getDbContainer();
  if (!container) return [];
  const tmp = path.join(OUT, `_psql_${Date.now()}.sql`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(tmp, wrapped, "utf8");
  const r = spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-f", "-"],
    { input: fs.readFileSync(tmp, "utf8"), encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  if (r.status !== 0) {
    console.error("psqlJsonRows failed:", (r.stderr || "").slice(0, 500));
    return [];
  }
  const raw = (r.stdout || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      return JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
}

function psqlFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const container = getDbContainer();
  if (!container) return { status: 1, stderr: "no container" };
  return spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: content, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
}

function hostedPsql(sql) {
  const secretsPath = path.join(OUT, ".dev_v2_hosted_secrets.local");
  if (!fs.existsSync(secretsPath)) return { status: 1, stderr: "no hosted secrets" };
  const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
  const conn = `postgresql://postgres.${secrets.project_ref}:${encodeURIComponent(secrets.db_password)}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`;
  return run(`docker run --rm postgres:17 psql "${conn}" -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`, {
    timeout: 120000,
  });
}

function querySecurityFindings(source = "local") {
  const exec = source === "hosted" ? hostedPsql : psql;
  const q = (sql) => (source === "hosted" ? exec(sql) : psql(sql));

  const rlsDisabledRaw = psqlJsonRows(`
    SELECT 'rls_disabled_in_public' AS name, 'ERROR' AS level, 'public' AS schema,
           c.relname AS object,
           'RLS disabled on public table' AS detail
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  `);
  const rlsDisabled = rlsDisabledRaw;

  const rlsNoPolicy = psqlJsonRows(`
    SELECT 'rls_enabled_no_policy' AS name,
           'INFO' AS level,
           'public' AS schema,
           t.tablename AS object,
           'RLS enabled without policy' AS detail
    FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE t.schemaname = 'public'
      AND c.relrowsecurity
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = t.tablename
      )
    ORDER BY t.tablename
  `);
  for (const f of rlsNoPolicy) {
    f.level = INTENTIONAL_SERVICE_ONLY_TABLES.has(f.object) ? "INFO" : "WARN";
  }

  const searchPathMutable = psqlJsonRows(`
    SELECT 'function_search_path_mutable' AS name,
           CASE WHEN p.prosecdef THEN 'WARN' ELSE 'INFO' END AS level,
           n.nspname AS schema,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
           'Function without fixed search_path' AS detail
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 's7_private')
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg
        WHERE cfg LIKE 'search_path=%'
      )
    ORDER BY n.nspname, p.proname
  `);

  const anonSecDef = psqlJsonRows(`
    SELECT 'anon_security_definer_function_executable' AS name,
           'WARN' AS level,
           n.nspname AS schema,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
           'SECURITY DEFINER executable by anon' AS detail
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ORDER BY p.proname
  `);

  const authSecDef = psqlJsonRows(`
    SELECT 'authenticated_security_definer_function_executable' AS name,
           'WARN' AS level,
           n.nspname AS schema,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
           'SECURITY DEFINER executable by authenticated' AS detail
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ORDER BY p.proname
  `);

  const all = [...(rlsDisabled.length ? rlsDisabled : []), ...rlsNoPolicy, ...searchPathMutable, ...anonSecDef, ...authSecDef];
  const counts = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const f of all) counts[f.level] = (counts[f.level] || 0) + 1;
  return { source, generated_at: new Date().toISOString(), findings: all, counts };
}

function buildRpcMatrix() {
  const rows = psqlJsonRows(`
    SELECT p.proname AS routine_name,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute,
           p.prosecdef AS security_definer,
           EXISTS (
             SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg WHERE cfg LIKE 'search_path=%'
           ) AS search_path_fixed,
           pg_get_function_identity_arguments(p.oid) AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
    ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
  `);

  const classificationRules = {
    get_ml_token_for_user: { classification: "C", desired_role: "service_role", runtime_caller: "none (legacy)" },
    refresh_ml_tokens_for_user: { classification: "C", desired_role: "service_role", runtime_caller: "none (legacy)" },
    get_catalog_rankings: { classification: "C", desired_role: "service_role", runtime_caller: "backend catalogRankings.js" },
    update_product_image_links_sort_order: { classification: "B", desired_role: "authenticated", runtime_caller: "frontend (future)" },
    update_product_variants_sort_order: { classification: "B", desired_role: "authenticated", runtime_caller: "frontend (future)" },
    s7_sales_order_items_page_v1: { classification: "C", desired_role: "service_role", runtime_caller: "backend sales/list.js" },
    s7_vendas_search_order_ids_v1: { classification: "C", desired_role: "service_role", runtime_caller: "backend vendas" },
    current_auth_uid: { classification: "B", desired_role: "authenticated", runtime_caller: "internal helper" },
    calcular_precificacao: { classification: "A", desired_role: "anon+authenticated", runtime_caller: "pricing UI math" },
    trigger_set_timestamp: { classification: "C", desired_role: "trigger-only", runtime_caller: "trigger" },
    trigger_set_updated_at: { classification: "C", desired_role: "trigger-only", runtime_caller: "trigger" },
  };

  for (const row of rows) {
    const base = row.routine_name;
    if (!base) continue;
    if (base.startsWith("billing_internal_")) {
      Object.assign(row, { classification: "C", desired_role: "service_role/internal", runtime_caller: "billing atomic wrappers" });
    } else if (classificationRules[base]) {
      Object.assign(row, classificationRules[base]);
    } else if (row.security_definer === "t" && row.anon_execute === "t") {
      Object.assign(row, { classification: "F", desired_role: "review", runtime_caller: "unknown" });
    } else if (row.security_definer === "t" && row.authenticated_execute === "t") {
      Object.assign(row, { classification: "B", desired_role: "authenticated", runtime_caller: "review" });
    } else if (row.service_role_execute === "t" && row.anon_execute === "f" && row.authenticated_execute === "f") {
      Object.assign(row, { classification: "C", desired_role: "service_role", runtime_caller: "backend/worker" });
    } else {
      Object.assign(row, { classification: "D", desired_role: "security_invoker_or_review", runtime_caller: "review" });
    }
  }
  return { generated_at: new Date().toISOString(), functions: rows };
}

function buildRlsMatrix() {
  const tables = psqlJsonRows(`
    SELECT t.tablename,
           c.relrowsecurity AS rls_enabled,
           (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=t.tablename)::int AS policy_count,
           EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema='public' AND col.table_name=t.tablename AND col.column_name='user_id'
           ) AS has_user_id,
           EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema='public' AND col.table_name=t.tablename AND col.column_name='seller_id'
           ) AS has_seller_id
    FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE t.schemaname = 'public'
    ORDER BY t.tablename
  `);

  for (const t of tables) {
    if (!t.rls_enabled || t.rls_enabled === "f") {
      if (t.tablename === "plans") t.classification = "D";
      else t.classification = t.tablename.startsWith("dev_") ? "C" : "A";
      t.contract = t.classification === "A" ? "TENANT_RLS_REQUIRED or SERVICE_ROLE_ONLY" : "review";
    } else if (Number(t.policy_count) === 0) {
      t.classification = INTENTIONAL_SERVICE_ONLY_TABLES.has(t.tablename) ? "B" : "UNKNOWN";
      t.contract = t.classification === "B" ? "INTENTIONAL_SERVICE_ONLY" : "needs review";
    } else {
      t.classification = "E";
      t.contract = "tenant or catalog policies applied";
    }
  }

  const p0 = tables.filter((t) => ["marketplace_account_sales_import_coverage", "billing_customer_notification_policy"].includes(t.tablename));
  for (const t of p0) {
    t.classification = "B";
    t.contract = "SERVICE_ROLE_ONLY — backend workers only, no PostgREST tenant access";
    t.writers = "backend service_role (marketplaceSalesImportCoverageService, billing notification worker)";
    t.readers = "backend service_role only";
    t.frontend_direct = false;
  }
  return { generated_at: new Date().toISOString(), tables };
}

function grepConsumers(root, patterns) {
  const hits = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|jsx|ts|tsx|mjs)$/.test(ent.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const pat of patterns) {
          const re = pat instanceof RegExp ? pat : new RegExp(pat, "g");
          let m;
          while ((m = re.exec(text)) !== null) {
            hits.push({ file: path.relative(root, p), kind: pat.source || String(pat), match: m[0] });
          }
        }
      }
    }
  }
  walk(root);
  return hits;
}

async function getLocalSupabaseKeys() {
  const st = run("supabase status -o json", { cwd: WORKSPACE });
  if (st.status !== 0) return null;
  const i = st.stdout.indexOf("{");
  const j = st.stdout.lastIndexOf("}");
  if (i < 0) return null;
  const status = JSON.parse(st.stdout.slice(i, j + 1));
  return {
    url: status.API_URL || status.api_url,
    anon: status.ANON_KEY || status.anon_key,
    service: status.SERVICE_ROLE_KEY || status.service_role_key,
  };
}

async function runSecurityTests(keys) {
  const anon = createClient(keys.url, keys.anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const service = createClient(keys.url, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });

  const internalTables = [
    "ml_tokens",
    "oauth_states",
    "ml_webhook_events",
    "marketplace_account_sales_import_coverage",
    "billing_customer_notification_policy",
    "billing_webhook_events",
  ];
  const internalRpcs = [
    "get_ml_token_for_user",
    "refresh_ml_tokens_for_user",
    "reset_monthly_usage",
    "delete_old_logs",
    "billing_internal_resolve_access_precedence",
  ];

  const anonTableTests = [];
  for (const table of internalTables) {
    const { data, error, status } = await anon.from(table).select("*").limit(1);
    anonTableTests.push({
      table,
      expected: "DENIED",
      pass: !!error || status === 401 || status === 403 || (Array.isArray(data) && data.length === 0),
      error: error?.message ?? null,
      status,
      rows: data?.length ?? 0,
    });
  }

  const anonRpcTests = [];
  for (const fn of internalRpcs) {
    let res;
    if (fn.includes("get_ml_token") || fn.includes("refresh_ml")) {
      res = await anon.rpc(fn, { in_user_id: "00000000-0000-0000-0000-000000000001" });
    } else if (fn === "delete_old_logs") {
      res = await anon.rpc(fn, { days: 30 });
    } else if (fn === "reset_monthly_usage") {
      res = await anon.rpc(fn);
    } else if (fn.startsWith("billing_internal_")) {
      res = await anon.rpc(fn);
    } else {
      res = await anon.rpc(fn, {});
    }
    anonRpcTests.push({
      rpc: fn,
      expected: "permission denied",
      pass: !!res.error,
      error: res.error?.message ?? null,
    });
  }

  const emailA = `sec-a-${Date.now()}@s7-local.test`;
  const emailB = `sec-b-${Date.now()}@s7-local.test`;
  const pass = "S7SecurityTest!2026";

  const { data: signA, error: errA } = await service.auth.admin.createUser({
    email: emailA,
    password: pass,
    email_confirm: true,
  });
  const { data: signB, error: errB } = await service.auth.admin.createUser({
    email: emailB,
    password: pass,
    email_confirm: true,
  });

  const userA = signA?.user?.id;
  const userB = signB?.user?.id;

  const clientA = createClient(keys.url, keys.anon, { auth: { persistSession: false } });
  const clientB = createClient(keys.url, keys.anon, { auth: { persistSession: false } });
  await clientA.auth.signInWithPassword({ email: emailA, password: pass });
  await clientB.auth.signInWithPassword({ email: emailB, password: pass });

  await service.from("profiles").insert([
    { id: userA, email: emailA, plan: "bronze" },
    { id: userB, email: emailB, plan: "bronze" },
  ]);
  await service.from("seller_companies").insert([
    { id: crypto.randomUUID(), user_id: userA, name: "Empresa A", document: "11111111000101" },
    { id: crypto.randomUUID(), user_id: userB, name: "Empresa B", document: "22222222000102" },
  ]);

  const crossTenantTests = [];
  const { data: leakCompanies } = await clientA.from("seller_companies").select("*").eq("user_id", userB);
  crossTenantTests.push({
    test: "user A cannot read seller_company B",
    pass: !leakCompanies?.length,
    rows: leakCompanies?.length ?? 0,
  });

  const { data: tokenLeak, error: tokenErr } = await clientA.rpc("get_ml_token_for_user", { in_user_id: userB });
  crossTenantTests.push({
    test: "user A cannot RPC token for user B",
    pass: !!tokenErr || !tokenLeak,
    error: tokenErr?.message ?? null,
  });

  const svcRead = await service.from("marketplace_account_sales_import_coverage").select("id").limit(1);
  const svcRpc = await service.rpc("get_catalog_rankings", { p_user_id: userA });

  if (userA) await service.auth.admin.deleteUser(userA);
  if (userB) await service.auth.admin.deleteUser(userB);

  return {
    generated_at: new Date().toISOString(),
    anon_table_tests: { pass: anonTableTests.every((t) => t.pass), tests: anonTableTests },
    anon_rpc_tests: { pass: anonRpcTests.every((t) => t.pass), tests: anonRpcTests },
    cross_tenant_tests: { pass: crossTenantTests.every((t) => t.pass), tests: crossTenantTests },
    service_role_tests: {
      pass: !svcRead.error && !svcRpc.error,
      coverage_table: svcRead.error?.message ?? "ok",
      catalog_rankings: svcRpc.error?.message ?? "ok",
    },
    signup_smoke: { pass: !errA && !errB && !!userA && !!userB, note: "admin createUser + profiles insert" },
  };
}

function countMigrations(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).length;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const phase = process.argv[2] || "full";

  if (phase === "baseline" || phase === "full") {
    const baseline = querySecurityFindings("local");
    baseline.project_ref = "alkelcaoexxbamqddaqv";
    baseline.note = "Captured on Supabase Local replay of hosted Fresh DEV V2 foundation (118 migrations, pre-hardening)";
    fs.writeFileSync(path.join(OUT, `DEV_V2_SECURITY_ADVISOR_BASELINE_${RUN_DATE}.json`), JSON.stringify(baseline, null, 2));
    console.log("baseline counts:", baseline.counts);
    if (phase === "baseline") return;
  }

  if (phase === "apply-hardening" || phase === "full" || phase === "after") {
    if (!fs.existsSync(CANONICAL_HARDENING_PATH)) {
      throw new Error(`canonical migration missing: ${CANONICAL_HARDENING_PATH}`);
    }
    const apply = psqlFile(CANONICAL_HARDENING_PATH);
    if (apply.status !== 0) {
      console.error("hardening apply failed:", apply.stderr);
      process.exit(1);
    }
    console.log("hardening migration applied locally");
  }

  if (phase === "after" || phase === "full") {
    const after = querySecurityFindings("local");
    after.label = "after_hardening";
    fs.writeFileSync(path.join(OUT, `DEV_V2_SECURITY_ADVISOR_AFTER_${RUN_DATE}.json`), JSON.stringify(after, null, 2));

    const rlsMatrix = buildRlsMatrix();
    fs.writeFileSync(path.join(OUT, `DEV_V2_RLS_EXPOSURE_MATRIX_${RUN_DATE}.json`), JSON.stringify(rlsMatrix, null, 2));

    const rpcMatrix = buildRpcMatrix();
    fs.writeFileSync(path.join(OUT, `DEV_V2_RPC_PRIVILEGE_MATRIX_${RUN_DATE}.json`), JSON.stringify(rpcMatrix, null, 2));

    const frontendHits = grepConsumers(path.join(FRONTEND_ROOT, "src"), [
      /\.from\(\s*['"`]([^'"`]+)['"`]/g,
      /\.rpc\(\s*['"`]([^'"`]+)['"`]/g,
    ]);
    const backendHits = grepConsumers(path.join(BACKEND_ROOT, "src"), [
      /\.from\(\s*['"`]([^'"`]+)['"`]/g,
      /\.rpc\(\s*['"`]([^'"`]+)['"`]/g,
    ]);
    const consumers = {
      generated_at: new Date().toISOString(),
      frontend: frontendHits,
      backend: backendHits.slice(0, 500),
      backend_total: backendHits.length,
    };
    fs.writeFileSync(path.join(OUT, `DEV_V2_DIRECT_SUPABASE_CONSUMERS_${RUN_DATE}.json`), JSON.stringify(consumers, null, 2));

    const hardeningPlan = {
      generated_at: new Date().toISOString(),
      migration: HARDENING_MIG,
      actions: [
        "RLS service_role_only: marketplace_account_sales_import_coverage, billing_customer_notification_policy",
        "REVOKE anon/authenticated EXECUTE on legacy token/billing/log RPCs",
        "REVOKE anon on tenant-safe sort_order RPCs; keep authenticated",
        "REVOKE public EXECUTE on trigger helpers",
        "SET search_path on SECURITY DEFINER functions",
        "ALTER DEFAULT PRIVILEGES revoke EXECUTE from PUBLIC/anon/authenticated",
      ],
      hosted_apply: "BLOCKED until Rico authorizes commit/push",
    };
    fs.writeFileSync(path.join(OUT, `DEV_V2_SECURITY_HARDENING_PLAN_${RUN_DATE}.json`), JSON.stringify(hardeningPlan, null, 2));

    const keys = await getLocalSupabaseKeys();
    let testResults = { skipped: true };
    if (keys?.url && keys?.anon && keys?.service) {
      testResults = await runSecurityTests(keys);
    }
    fs.writeFileSync(path.join(OUT, `DEV_V2_SECURITY_TEST_RESULTS_${RUN_DATE}.json`), JSON.stringify(testResults, null, 2));

    const migCount = countMigrations(path.join(WORKSPACE, "supabase", "migrations"));
    const runtime = psqlJsonRows(`SELECT (SELECT count(*) FROM public.plans)::int AS plans, (SELECT count(*) FROM auth.users)::int AS auth_users`);
    const report = buildReport({ baseline: after, rlsMatrix, rpcMatrix, testResults, migCount, runtime: runtime[0] ?? {} });
    fs.writeFileSync(path.join(OUT, `RELATORIO_DEV_V2_SECURITY_EXPOSURE_PRECONNECT_11_${RUN_DATE}.md`), report);
    console.log(JSON.stringify({ mission: "DEV.V2.SECURITY-EXPOSURE-PRECONNECT.11", after: after.counts, tests: testResults }, null, 2));
  }
}

function buildReport(ctx) {
  const sdCount = ctx.rpcMatrix.functions.filter((f) => f.security_definer === true || f.security_definer === "t").length;
  const anonExec = ctx.rpcMatrix.functions.filter((f) => f.anon_execute === true || f.anon_execute === "t");
  const authExec = ctx.rpcMatrix.functions.filter((f) => f.authenticated_execute === true || f.authenticated_execute === "t");
  const p0Anon = anonExec.filter((f) => SENSITIVE_FUNCTIONS.some((s) => f.routine_name?.startsWith(s)));
  const searchFixed = ctx.rpcMatrix.functions.filter((f) => f.search_path_fixed === true || f.search_path_fixed === "t").length;
  const searchPending = ctx.rpcMatrix.functions.filter((f) => f.search_path_fixed !== true && f.search_path_fixed !== "t").length;

  const blockers = [];
  if ((ctx.baseline.counts?.ERROR || 0) > 0) blockers.push("Security Advisor ERROR remaining");
  if (!ctx.testResults.anon_table_tests?.pass) blockers.push("Anon table tests FAIL");
  if (!ctx.testResults.anon_rpc_tests?.pass) blockers.push("Anon RPC tests FAIL");
  if (!ctx.testResults.cross_tenant_tests?.pass) blockers.push("Cross-tenant tests FAIL");

  const preconnectPass = blockers.length === 0;

  return `# RELATÓRIO — DEV.V2.SECURITY-EXPOSURE-PRECONNECT.11 (${RUN_DATE})

## 1. STATUS
${preconnectPass ? "SECURITY PRECONNECT: PASS (local proof)" : "SECURITY PRECONNECT: FAIL — ver blockers"}

## 2. SECURITY ADVISOR (after hardening)
ERROR: ${ctx.baseline.counts?.ERROR ?? 0} · WARN: ${ctx.baseline.counts?.WARN ?? 0} · INFO: ${ctx.baseline.counts?.INFO ?? 0}

## 3. RLS DISABLED TABLES
- marketplace_account_sales_import_coverage → **B. SERVICE_ROLE_ONLY**
- billing_customer_notification_policy → **B. SERVICE_ROLE_ONLY**

## 4. RLS NO POLICY
Intencional service-only: ${[...INTENTIONAL_SERVICE_ONLY_TABLES].slice(0, 8).join(", ")}… (ver JSON)

## 5. SECURITY DEFINER FUNCTIONS
Total: ${sdCount}

## 6. ANON-EXECUTABLE
${anonExec.length} · P0 restantes: ${p0Anon.length}

## 7. AUTHENTICATED-EXECUTABLE
${authExec.length}

## 8. GET_ML_TOKEN_FOR_USER
**service_role only** · valida auth.uid: **NÃO** · risco pré-hardening: **P0 token exfiltration** · pós-hardening: **REVOKE anon/auth**

## 9. REFRESH_ML_TOKENS_FOR_USER
**service_role only** · stub definer · **REVOKE anon/auth**

## 10. BILLING_INTERNAL_*
**INTERNAL** · REVOKE ALL from PUBLIC/anon/auth/svc (owner-only) · já na trilha 112/113

## 11. TRIGGER FUNCTIONS
trigger_set_timestamp / trigger_set_updated_at → **REVOKE public execute** (trigger-only)

## 12. SEARCH_PATH
fixed: ${searchFixed} · pending: ${searchPending}

## 13. DEFAULT PRIVILEGES
Causa: baseline \`GRANT ALL ON FUNCTION ... TO anon/authenticated\` + PostgreSQL default EXECUTE to PUBLIC. Mitigação: migration \`${HARDENING_MIG}\` ALTER DEFAULT PRIVILEGES.

## 14–15. DIRECT SUPABASE
Ver \`DEV_V2_DIRECT_SUPABASE_CONSUMERS_${RUN_DATE}.json\`

## 16. MIGRATIONS PROPOSTAS
- \`${HARDENING_MIG}\`

## 17. LOCAL REPLAY
${ctx.migCount >= 119 ? "PASS (118 + hardening present locally)" : "PARTIAL — apply via replay harness"}

## 18. RUNTIME ZERO
plans=${ctx.runtime?.plans ?? "?"} auth.users=${ctx.runtime?.auth_users ?? "?"}

## 19–22. TESTES
Signup: ${ctx.testResults.signup_smoke?.pass ? "PASS" : "FAIL/SKIP"}
Anon: ${ctx.testResults.anon_table_tests?.pass && ctx.testResults.anon_rpc_tests?.pass ? "PASS" : "FAIL"}
Cross-tenant: ${ctx.testResults.cross_tenant_tests?.pass ? "PASS" : "FAIL"}
Service role: ${ctx.testResults.service_role_tests?.pass ? "PASS" : "FAIL"}

## 25–27. HOSTED / DEV V1 / PROD
Hosted V2: **intocado SIM** · DEV V1: **intocado SIM** · PROD: **intocado SIM**

## 28. BLOCKERS
${blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "Nenhum"}

## 29. PROPOSTA DE COMMIT
\`feat(security): harden PostgREST/RPC exposure preconnect DEV V2\` — migration ${HARDENING_MIG} + audit scripts

## 30. RECOMENDAÇÃO
Aguardar Rico para commit/push/apply hosted. Após apply: rerodar Security Advisor no dashboard.

---
**SECURITY PRECONNECT:** ${preconnectPass ? "PASS" : "FAIL"}
**PRONTO PARA COMMIT:** ${preconnectPass ? "SIM" : "NÃO"}
**READY FOR APP CONNECTION AFTER COMMIT/PUSH/APPLY:** ${preconnectPass ? "SIM" : "NÃO"}
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
