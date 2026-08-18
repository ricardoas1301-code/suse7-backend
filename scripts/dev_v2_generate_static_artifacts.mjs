#!/usr/bin/env node
/**
 * Gera artefatos estáticos DEV.V2.MIGRATION-REPLAY-GAPS.01 (sem Docker).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "suse7-frontend");
const OUT = path.join(__dirname, "output");
const RUN_DATE = "2026-08-13";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.startsWith("APPLY_MANUAL")).sort();
}

const backendDir = path.join(BACKEND_ROOT, "supabase", "migrations");
const backendMigs = listSql(backendDir);
const frontendMigs = listSql(path.join(FRONTEND_ROOT, "supabase", "migrations"));

const orphanClassification = {
  generated_at: new Date().toISOString(),
  mission: "DEV.V2.MIGRATION-REPLAY-GAPS.01",
  items: [
    {
      path: "suse7-backend/scripts/migrations/20260508_marketplace_account_sales_import_coverage.sql",
      timestamp: "20260508",
      summary: "CREATE marketplace_account_sales_import_coverage + indexes",
      objects: ["marketplace_account_sales_import_coverage"],
      dependencies: ["marketplace_account_sync_jobs (logical)", "marketplace_accounts"],
      applied_in_dev: "table exists, count=0 (read-only probe)",
      equivalent_canonical: false,
      duplicate: false,
      obsolete: false,
      class: "A_REQUIRED_CANONICAL_MIGRATION",
      canonical_decision: "supabase/migrations/20260510130000_marketplace_account_sales_import_coverage.sql",
      canonical_position: "after 20260510120000_marketplace_account_sync_jobs",
    },
    {
      path: "suse7-backend/scripts/migrations/20260513_billing_payment_methods.sql",
      timestamp: "20260513",
      summary: "CREATE billing_payment_methods + RLS",
      objects: ["billing_payment_methods"],
      dependencies: ["auth.users"],
      applied_in_dev: "table exists, count=11",
      equivalent_canonical: false,
      class: "A_REQUIRED_CANONICAL_MIGRATION",
      canonical_decision: "merged into supabase/migrations/20260513190000_billing_payment_methods.sql",
      canonical_position: "after 20260513180000, before 20260519120000 renewal_cycles",
    },
    {
      path: "suse7-backend/scripts/migrations/20260518_billing_payment_methods_card_type.sql",
      timestamp: "20260518",
      summary: "ALTER billing_payment_methods card_type + supports_auto_renew",
      class: "B_DUPLICATE_ALREADY_CANONICAL",
      note: "Merged into 20260513190000 forward migration (single CREATE with columns)",
    },
    {
      path: "ProjetosDev/scripts/migrations/20260812_legal_document_acceptances.sql",
      timestamp: "20260812",
      summary: "CREATE legal_document_acceptances + RLS",
      objects: ["legal_document_acceptances"],
      dependencies: ["auth.users"],
      applied_in_dev: "table exists, count=0",
      code_consumer: "src/legal/routes/legalRoutes.js",
      class: "A_REQUIRED_CANONICAL_MIGRATION",
      canonical_decision: "supabase/migrations/20260812130000_legal_document_acceptances.sql",
      canonical_position: "after 20260812120000_s7_primary_company_default_recipient",
    },
  ],
};

const dependencyReport = {
  generated_at: new Date().toISOString(),
  backend_migration_count: backendMigs.length,
  frontend_migration_count: frontendMigs.length,
  critical_architecture_finding: {
    severity: "BLOCKER_FOR_BACKEND_ONLY_REPLAY",
    message:
      "Backend supabase/migrations are INCREMENTAL (ALTER/RPC). Core tables (profiles, marketplace_accounts, sales_orders, plans, products) are NOT created in backend chain.",
    baseline_location: "suse7-frontend/supabase/migrations/20260301215430_baseline_public_from_prod.sql",
    replay_chain_required: [
      "1) auth/storage bootstrap stub",
      "2) frontend baseline_public_from_prod.sql",
      "3) backend migrations (sorted)",
      "4) frontend migrations post-baseline (optional, may overlap)",
    ],
  },
  first_backend_migration: backendMigs[0],
  first_backend_migration_requires: "public.sales_order_items already exists",
  orphan_migrations_outside_canonical: [
    "scripts/migrations/20260508... (now canonical 20260510130000)",
    "scripts/migrations/20260513+18 (now canonical 20260513190000)",
    "ProjetosDev/scripts/migrations/20260812 (now canonical 20260812130000)",
  ],
  heuristic_issues_sample: backendMigs.slice(0, 5).map((f) => ({
    file: f,
    alters_without_create: /ALTER TABLE/i.test(fs.readFileSync(path.join(backendDir, f), "utf8")),
  })),
  migration_managed_global_inserts: backendMigs
    .filter((f) => /INSERT INTO/i.test(fs.readFileSync(path.join(backendDir, f), "utf8")))
    .map((f) => {
      const c = fs.readFileSync(path.join(backendDir, f), "utf8");
      const tables = [...new Set((c.match(/INSERT INTO\s+([^\s(]+)/gi) || []).map((x) => x.replace(/INSERT INTO\s+/i, "")))];
      return { file: f, tables };
    }),
};

const fingerprint = {
  generated_at: new Date().toISOString(),
  canonical_chain: "suse7-backend/supabase/migrations",
  count: backendMigs.length,
  aggregate_sha256: sha256(backendMigs.map((f) => sha256(fs.readFileSync(path.join(backendDir, f), "utf8"))).join("\n")),
  files: backendMigs.map((f) => ({
    file: f,
    sha256: sha256(fs.readFileSync(path.join(backendDir, f), "utf8")),
  })),
};

const seedStrategy = {
  decision: "A",
  label: "MIGRATIONS_ALREADY_SUFFICIENT",
  seed_sql_required: false,
  rationale:
    "Global reference data (s7_notification_*, billing_notification_templates, billing lifecycle seeds) is embedded in 13+ migrations. supabase/seed.sql absence is NOT a blocker if combined replay proves counts.",
  global_data_classification: [
    { object: "plans", class: "RUNTIME_CREATED_OR_BASELINE", note: "Referenced by billing_subscriptions FK; created in frontend baseline, not backend migrations" },
    { object: "s7_notification_templates", class: "MIGRATION_MANAGED", migrations: ["20260522140000", "20260523120000", "20260608171000", "20260609180000", "20260610120000"] },
    { object: "s7_notification_event_types", class: "MIGRATION_MANAGED" },
    { object: "billing_notification_templates", class: "MIGRATION_MANAGED" },
    { object: "storage company-logos bucket", class: "MIGRATION_MANAGED", migration: "20260512120000" },
    { object: "scripts/sql/billing_*_seed_*.sql", class: "TEST_FIXTURE", note: "DEV deployment identity — not for fresh V2 baseline" },
  ],
};

const globalBaseline = {
  note: "Expected counts derivable only after successful combined replay. DEV V1 probe (read-only) for reference:",
  dev_v1_probe_readonly: {
    plans: 8,
    billing_payment_methods: 11,
    marketplace_account_sales_import_coverage: 0,
    legal_document_acceptances: 0,
  },
  post_replay_expected: "COUNT(s7_notification_templates) > 0; COUNT(s7_notification_event_types) > 0; runtime tenant tables = 0",
};

const projectSettingsRunbook = {
  generated_at: new Date().toISOString(),
  not_recreated_by_sql_migrations: [
    "Supabase Auth Site URL / redirect URLs",
    "Auth email templates and provider config",
    "Project API keys (anon, service_role)",
    "Realtime publication",
    "Vercel env: SUPABASE_URL, keys, JOB_SECRET, CRON_SECRET, DEV_*_JOB_URL",
    "ML OAuth app credentials and redirect URI",
    "Asaas sandbox webhook URL + ASAAS_WEBHOOK_TOKEN",
    "GitHub Actions secrets",
  ],
  storage: {
    company_logos: {
      recreatable_via_migration: true,
      migration: "20260512120000_storage_company_logos_bucket.sql",
      fresh_dev_tenant_objects: 0,
    },
    audit_status: "PARTIAL — bucket SQL in migration; object inventory pending EXECUTE",
  },
};

const replayLog = {
  first_replay_backend_only: {
    status: "FAIL_PREDICTED",
    failed_at_migration: "20260208140000_s7_vendas_global_order_rpc.sql",
    reason: "ALTER TABLE public.sales_order_items — table does not exist on empty DB",
    executed: false,
    note: "Static analysis; Docker unavailable for live proof",
  },
  combined_replay_baseline_plus_backend: {
    status: "BLOCKED",
    reason: "Docker daemon unavailable on agent host (dockerDesktopLinuxEngine pipe missing)",
    script_ready: "scripts/dev_v2_migration_replay_local.mjs",
    chain_file_count: 1 + backendMigs.length,
  },
  second_clean_replay: {
    status: "BLOCKED",
    reason: "Depends on first combined PASS",
  },
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `DEV_V2_ORPHAN_MIGRATIONS_CLASSIFICATION_${RUN_DATE}.json`), JSON.stringify(orphanClassification, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_MIGRATION_DEPENDENCY_REPORT_${RUN_DATE}.json`), JSON.stringify(dependencyReport, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_GLOBAL_REFERENCE_BASELINE_${RUN_DATE}.json`), JSON.stringify(globalBaseline, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_PROJECT_SETTINGS_RUNBOOK_${RUN_DATE}.json`), JSON.stringify(projectSettingsRunbook, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_CANONICAL_MIGRATION_FINGERPRINT_${RUN_DATE}.json`), JSON.stringify(fingerprint, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_REPLAY_LOG_${RUN_DATE}.json`), JSON.stringify({ replayLog, seedStrategy }, null, 2));
console.log(JSON.stringify({ backendMigs: backendMigs.length, fingerprint: fingerprint.aggregate_sha256.slice(0, 16) }, null, 2));
