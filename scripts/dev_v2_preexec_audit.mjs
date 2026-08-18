#!/usr/bin/env node
/**
 * DEV.CLEAN-RESET.FULL.V2.PREEXEC.01 — auditoria read-only + artefatos.
 * NÃO executa DELETE/DROP/TRUNCATE.
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { extractSupabaseProjectRef, S7_SUPABASE_PROJECT_REF } from "../src/billing/services/billingRuntimeEnvironmentService.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "output");
const RUN_DATE = "2026-08-13";

const REQUIRED_COMMITS = [
  "832cba4",
  "b0ae94a",
  "9122409",
  "0dbada5",
  "26576ee",
  "22e4a5c",
  "973cdd9",
  "489f64a",
];

/** Commits marketplace/sync atribuídos à cadeia Simão (identificados por mensagem/autor ausente no log). */
const SIMAO_SYNC_COMMITS_CANDIDATES = [
  { hash: "832cba4", subject: "fix(marketplace): restore DEV sync import chain and incremental catch-up" },
  { hash: "b0ae94a", subject: "fix(marketplace): explicit catch-up chunks and honest incremental persist counts" },
  { hash: "9122409", subject: "feat(ml-webhook): event-first orders_v2 with fast ACK and fair queue" },
  { hash: "0dbada5", subject: "fix(ml-webhook): tenant context on legacy events + retry/stale lanes" },
  { hash: "26576ee", subject: "fix(sales): idempotencia canonica sales_order_items contra race concorrente" },
  { hash: "22e4a5c", subject: "fix(sales): preserve historical financial snapshots on reprocessing" },
  { hash: "973cdd9", subject: "fix(ml-webhook): distinguish entitlement ignored from persisted done" },
  { hash: "489f64a", subject: "feat(financial): add snapshot provenance v2 contract" },
];

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function listMigrations(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function scanMigrationSeeds(migrationsDir) {
  const seeds = [];
  for (const file of listMigrations(migrationsDir)) {
    const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const inserts = (content.match(/^INSERT\s+INTO\s+[\w."']+/gim) || []).length;
    if (inserts > 0) {
      seeds.push({ file, insert_statements: inserts });
    }
  }
  return seeds;
}

async function countTable(supabase, table, filterFn) {
  try {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    if (filterFn) q = filterFn(q);
    const { count, error } = await q;
    return error ? { count: null, error: error.message } : { count: count ?? 0 };
  } catch (e) {
    return { count: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function buildForensicCounts(supabase) {
  const tables = [
    "profiles",
    "seller_companies",
    "marketplace_accounts",
    "ml_tokens",
    "products",
    "marketplace_listings",
    "sales_orders",
    "sales_order_items",
    "ml_webhook_events",
    "marketplace_account_sync_jobs",
    "billing_subscriptions",
    "billing_customers",
    "notification_contacts",
    "competition_monitored_listings",
    "pricing_current_state",
    "operational_tasks",
  ];
  /** @type {Record<string, unknown>} */
  const counts = {};
  for (const t of tables) {
    counts[t] = await countTable(supabase, t);
  }
  return counts;
}

function buildGitBaseline() {
  const head = git("log -1 --format=%H");
  const headShort = git("log -1 --format=%h");
  const branch = git("branch --show-current");
  const commitStatus = REQUIRED_COMMITS.map((c) => ({
    hash: c,
    subject: git(`log -1 --format=%s ${c}`),
    in_ancestry: git(`merge-base --is-ancestor ${c} HEAD`) === "",
  }));
  const missing = commitStatus.filter((c) => !c.in_ancestry);
  return {
    generated_at: new Date().toISOString(),
    mission: "DEV.CLEAN-RESET.FULL.V2.PREEXEC.01",
    head,
    head_short: headShort,
    branch,
    required_commits: commitStatus,
    missing_required: missing.map((m) => m.hash),
    simao_sync_commits: SIMAO_SYNC_COMMITS_CANDIDATES.map((c) => ({
      ...c,
      in_ancestry: git(`merge-base --is-ancestor ${c.hash} HEAD`) === "",
    })),
    note: "Nenhum commit com autor 'Simão' encontrado no git log — cadeia identificada por mensagens marketplace/ml-webhook/financial.",
  };
}

function buildReplayGapMatrix(migrations, orphanMigrations, seedMigrations) {
  /** @type {Record<string, unknown>[]} */
  const gaps = [];

  for (const o of orphanMigrations) {
    gaps.push({
      object: o,
      current_dev: "unknown",
      repo_source: "scripts/migrations (fora supabase/migrations)",
      replayable: false,
      severity: "BLOCKER",
      required_fix: "Mover/versionar em supabase/migrations ou incorporar conteúdo",
    });
  }

  const globalTables = [
    { object: "billing_plans", classification: "MIGRATION_CREATED", expected: "plans/limits em migrations billing" },
    { object: "notification_templates", classification: "MIGRATION_CREATED", expected: "templates em migrations phase5x" },
    { object: "notification_catalog", classification: "MIGRATION_CREATED", expected: "catalog central phase511" },
    { object: "marketplace_definitions", classification: "RUNTIME_CREATED", expected: "enum/code — não tabela" },
    { object: "storage_company_logos_bucket", classification: "MIGRATION_CREATED", expected: "20260512120000_storage_company_logos_bucket.sql" },
    { object: "supabase/seed.sql", classification: "SEED_REQUIRED", expected: "AUSENTE no repo — gap potencial" },
    { object: "scripts/sql/billing_*_seed_*.sql", classification: "MANUAL_DRIFT", expected: "seeds DEV deployment identity — não replay automático" },
    { object: "scripts/seed_ssot_hist_target_samples.mjs", classification: "RUNTIME_CREATED", expected: "fixture manual — não necessário pós-reset" },
  ];

  for (const g of globalTables) {
    gaps.push({
      object: g.object,
      current_dev: g.expected,
      repo_source: g.classification,
      replayable: g.classification === "MIGRATION_CREATED",
      severity: g.classification === "SEED_REQUIRED" && g.object.includes("seed.sql") ? "HIGH" : g.classification === "MANUAL_DRIFT" ? "MEDIUM" : "LOW",
      required_fix:
        g.classification === "SEED_REQUIRED"
          ? "Criar seed.sql versionado ou consolidar inserts em migration"
          : g.classification === "MANUAL_DRIFT"
            ? "Documentar como optional DEV bootstrap ou migrar para seed"
            : null,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    migration_count: migrations.length,
    migration_seed_files: seedMigrations,
    orphan_migrations_outside_supabase: orphanMigrations,
    gaps,
    blocker_count: gaps.filter((g) => g.severity === "BLOCKER").length,
    high_count: gaps.filter((g) => g.severity === "HIGH").length,
  };
}

function buildWritersMap() {
  return {
    generated_at: new Date().toISOString(),
    global_maintenance_env: "DEV_GLOBAL_MAINTENANCE_MODE=1 + S7_APP_ENV=development + DEV project_ref",
    scheduler_shutdown: [
      "Disable .github/workflows/ml-webhook-events-cron-dev.yml",
      "Disable .github/workflows/marketplace-account-sync-cron-dev.yml",
      "Disable .github/workflows/billing-maintenance-cron-dev.yml",
      "Disable .github/workflows/daily-sales-summary-automation-cron-dev.yml",
      "Remove vercel.json crons (competition + daily-sales) and redeploy DEV",
    ],
    writers: {
      ml_webhook: { file: "src/handlers/ml/mlWebhookProcessor.js", pause: "global maintenance + disable GH cron" },
      ml_webhook_ingest: { file: "src/handlers/ml/mlWebhookRoutes.js", note: "ACK always; staging ml_webhook_events only" },
      incremental_poll: { file: "src/services/marketplace/mlIncrementalSalesPoll.js", pause: "global maintenance + ML_INCREMENTAL_SALES_POLL_ENABLE=0" },
      marketplace_sync: { file: "src/services/marketplace/marketplaceAccountSyncWorker.js", pause: "global maintenance + disable GH cron" },
      manual_sales_sync: { file: "src/handlers/ml/salesSync.js", pause: "global maintenance on apply" },
      listing_sync: { file: "src/handlers/ml/listingsAutoSync.js", pause: "user-driven; global maintenance on webhook path only" },
      competition_snapshot: { file: "src/handlers/jobs/competitionDailySnapshotJob.js", pause: "global maintenance + vercel cron off" },
      billing_renewal: { file: "src/handlers/jobs/billingRenewalEngineJob.js", pause: "global maintenance + GH cron off" },
      billing_reconcilers: { file: "src/handlers/jobs/billing*Reconciler*.js", pause: "do not call; rotate DEV_JOB_SECRET" },
      asaas_webhook: { file: "src/billing/routes/billingRoutes.js", pause: "disable sandbox webhook or rotate ASAAS_WEBHOOK_TOKEN" },
      daily_sales_summary: { file: "src/handlers/jobs/dailySalesSummaryAutomationJob.js", pause: "vercel cron + GH workflow off" },
      backfill_scripts: { file: "scripts/*.mjs", pause: "do not run manually during reset" },
    },
  };
}

function buildVercelEnvImpact() {
  return {
    note: "Nomes apenas — sem valores",
    backend: [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_ANON_KEY",
      "S7_APP_ENV",
      "S7_EXPECTED_SUPABASE_PROJECT_REF",
      "JOB_SECRET",
      "DEV_JOB_SECRET",
      "CRON_SECRET",
      "ASAAS_ENV",
      "ASAAS_API_KEY",
      "ASAAS_WEBHOOK_TOKEN",
      "ML_APP_ID",
      "ML_CLIENT_SECRET",
      "ML_REDIRECT_URI",
      "DEV_GLOBAL_MAINTENANCE_MODE",
    ],
    frontend: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_S7_APP_ENV"],
    github_actions_dev_secrets: [
      "DEV_JOB_SECRET",
      "DEV_ML_WEBHOOK_JOB_URL",
      "DEV_MARKETPLACE_SYNC_JOB_URL",
      "DEV_BILLING_PROCESS_PERIOD_EXPIRATIONS_JOB_URL",
      "DEV_BILLING_PROCESS_RENEWALS_JOB_URL",
      "DEV_DAILY_SALES_SUMMARY_JOB_URL",
    ],
    fresh_dev_v2_changes: "SUPABASE_URL + keys + S7_EXPECTED_SUPABASE_PROJECT_REF + all DEV_* job URLs pointing to same deployment",
  };
}

function writeJson(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

async function main() {
  const gitBaseline = buildGitBaseline();
  writeJson(`DEV_V2_REQUIRED_GIT_BASELINE_${RUN_DATE}.json`, gitBaseline);

  const migDir = path.join(ROOT, "supabase", "migrations");
  const orphanDir = path.join(ROOT, "scripts", "migrations");
  const rootOrphan = path.join(ROOT, "..", "scripts", "migrations");
  const migrations = listMigrations(migDir);
  const orphanMigrations = [
    ...listMigrations(orphanDir),
    ...listMigrations(rootOrphan).map((f) => `../scripts/migrations/${f}`),
  ].filter(Boolean);
  const seedMigrations = scanMigrationSeeds(migDir);

  const migrationFingerprint = migrations.map((f) => ({
    file: f,
    sha256: sha256File(path.join(migDir, f)),
  }));

  let migrationReplay = {
    status: "NOT_EXECUTED",
    reason: "Local supabase db reset not attempted in this run — requires Docker + supabase link",
    migration_count: migrations.length,
    first: migrations[0] ?? null,
    last: migrations[migrations.length - 1] ?? null,
  };

  try {
    execSync("docker info", { stdio: "ignore" });
    migrationReplay.docker_available = true;
    migrationReplay.recommendation = "Run: supabase db reset --local in isolated CI/agent before EXECUTE.01";
  } catch {
    migrationReplay.docker_available = false;
    migrationReplay.recommendation = "Provision temp Postgres or Supabase branch; apply migrations in order; diff schema vs DEV";
  }

  const gapMatrix = buildReplayGapMatrix(migrations, orphanMigrations, seedMigrations);
  writeJson(`DEV_V2_REPLAY_GAP_MATRIX_${RUN_DATE}.json`, gapMatrix);
  writeJson(`DEV_V2_AUTOMATIC_WRITERS_MAP_${RUN_DATE}.json`, buildWritersMap());
  writeJson(`DEV_V2_VERCEL_ENV_IMPACT_${RUN_DATE}.json`, buildVercelEnvImpact());

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const projectRef = extractSupabaseProjectRef(process.env);

  if (projectRef === S7_SUPABASE_PROJECT_REF.PROD) {
    console.error("ABORT: PROD project_ref");
    process.exit(2);
  }

  let forensic = {
    generated_at: new Date().toISOString(),
    mission: "DEV_V1_FINAL_FORENSIC_MANIFEST (proposta)",
    project_ref: projectRef,
    git_baseline: gitBaseline,
    migration_fingerprint: { count: migrationFingerprint.length, files: migrationFingerprint.slice(0, 5), truncated: migrationFingerprint.length > 5 },
    schema_fingerprint: "pending — requires pg_dump --schema-only on DEV before reset",
    row_counts_aggregated: null,
    known_incidents: [
      "Super Metal Rio duplicate accounts 677620487 (2 marketplace_accounts)",
      "WEBHOOK_ACCOUNT_AMBIGUOUS on legacy duplicate sellers",
      "INTEGRATION.ML.CONNECTION-TRUTH.01 — UI ATIVA vs OAuth absent/expired",
      "syncMercadoLivreSingleOrderByAccountId imported but not exported",
      "199 sales_order_items duplicate groups (dedup mission 2026-08-10)",
    ],
    known_legacy_sellers: ["677620487", "3531736693", "c8a62ec6 tenant homolog"],
    golden_fixtures_in_git: [
      "test_ssot_vendas_ao_vivo_golden_unit.mjs",
      "test_financial_snapshot_provenance_v2_unit.mjs",
      "test_sales_order_item_snapshot_preservation_unit.mjs",
      "mlWebhookOrderProcessorOutcome.test.js",
    ],
  };

  if (url && key && projectRef === S7_SUPABASE_PROJECT_REF.DEV) {
    const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    forensic.row_counts_aggregated = await buildForensicCounts(supabase);
  }

  writeJson(`DEV_V1_FINAL_FORENSIC_MANIFEST_${RUN_DATE}.json`, forensic);

  const summary = {
    git_baseline_ok: gitBaseline.missing_required.length === 0,
    migration_count: migrations.length,
    replay_blockers: gapMatrix.blocker_count,
    replay_high: gapMatrix.high_count,
    migration_replay: migrationReplay.status,
    maintenance_mode: "DEV_GLOBAL_MAINTENANCE_MODE=1 (local implementation, not deployed)",
  };

  writeJson(`DEV_V2_PREEXEC_SUMMARY_${RUN_DATE}.json`, summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
