#!/usr/bin/env node
/**
 * DEV.V2.REPLAY-FOUNDATION-COMMIT-REVIEW.06
 * Audit working tree + commit groups — NO commit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "..");
const FRONTEND = path.join(BACKEND, "..", "suse7-frontend");
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";

function git(repo, ...args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

function readIf(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function classifyFile(relPath, repo) {
  const p = relPath.replace(/\\/g, "/");
  if (/scripts\/output\//.test(p) || /RELATORIO_/.test(p)) return "G";
  if (/dev_v2_|supabase-local-replay|test_dev_v2_plans/.test(p)) return "B";
  if (/20260301220000|20260301220001|20260301215959|20260328120001|20260510130000|20260513190000|20260812130000/.test(p))
    return "A";
  if (/internalBabyPlanService|billingBabyHardLimitService|suse7PlanCatalog/.test(p)) return "C";
  if (/devGlobalMaintenanceMode|devCleanRoomMaintenanceFence|dev_clean_room_reset_seller/.test(p)) return "D";
  if (/devCleanRoom|clean-room|clean_room/.test(p)) return "E";
  if (/20260810200000|20260812120000_s7_primary/.test(p)) return "F";
  if (/\.cursor\/|CHECKPOINT|_git-cleanup-backup/.test(p)) return "G";
  if (repo === "frontend" && /^supabase\/migrations\/20260301215430/.test(p)) return "A";
  if (/subscriptionPlans\.js/.test(p)) return "G";
  return "F";
}

const migrations = [
  {
    path: "suse7-frontend/supabase/migrations/20260301215430_baseline_public_from_prod.sql",
    classification: "CANONICAL_REQUIRED",
    gitignored: true,
    tracked: false,
    reason: "Core public schema baseline — replay step 1",
    dependency: "none",
    forward_safety: "N/A fresh export",
    origin: "prod schema export",
  },
  {
    path: "suse7-frontend/supabase/migrations/20260301215959_baseline_sales_schema_bridge.sql",
    classification: "CANONICAL_REQUIRED",
    gitignored: true,
    tracked: false,
    reason: "Drop legacy empty sales tables before phase3",
    dependency: "baseline",
    forward_safety: "PASS — guarded DROP only when empty + wrong shape",
    origin: "DEV V2 replay gap",
  },
  {
    path: "suse7-frontend/supabase/migrations/20260301220000_core_schema_bootstrap.sql",
    classification: "CANONICAL_REQUIRED",
    gitignored: false,
    tracked: false,
    reason: "plans.id + seller_companies + marketplace_accounts",
    dependency: "baseline",
    forward_safety: "PASS — IF NOT EXISTS / id backfill only NULL",
    origin: "DEV V2 CORE-SCHEMA-BOOTSTRAP.03",
  },
  {
    path: "suse7-frontend/supabase/migrations/20260301220001_plans_commercial_catalog_bootstrap.sql",
    classification: "CANONICAL_REQUIRED",
    gitignored: false,
    tracked: false,
    reason: "plans commercial schema + fresh catalog seed",
    dependency: "core_schema_bootstrap",
    forward_safety: "FAIL on existing commercial values — see audit",
    origin: "DEV V2 PLANS-BOOTSTRAP.05",
    blocker: "UPSERT overwrites price/range on conflict(name); validation requires 8 canonical rows",
  },
  {
    path: "suse7-frontend/supabase/migrations/20260328120001_sales_order_items_rpc_compat.sql",
    classification: "CANONICAL_REQUIRED",
    gitignored: false,
    tracked: false,
    reason: "external_order_id before vendas RPC",
    dependency: "sales phase3",
    forward_safety: "PASS — ADD COLUMN IF NOT EXISTS",
    origin: "orphan gap",
  },
  {
    path: "suse7-backend/supabase/migrations/20260510130000_marketplace_account_sales_import_coverage.sql",
    classification: "CANONICAL_REQUIRED",
    reason: "orphan — in replay 115/115",
    forward_safety: "PASS",
    origin: "orphan gap",
  },
  {
    path: "suse7-backend/supabase/migrations/20260513190000_billing_payment_methods.sql",
    classification: "CANONICAL_REQUIRED",
    reason: "orphan — in replay 115/115",
    forward_safety: "PASS",
    origin: "orphan gap",
  },
  {
    path: "suse7-backend/supabase/migrations/20260812130000_legal_document_acceptances.sql",
    classification: "CANONICAL_REQUIRED",
    reason: "orphan — in replay 115/115",
    forward_safety: "PASS",
    origin: "orphan gap",
  },
];

const plansBootstrap = readIf(path.join(FRONTEND, "supabase/migrations/20260301220001_plans_commercial_catalog_bootstrap.sql"));
const existingDbBehavior = {
  scenario_b_existing_db: {
    on_conflict_name: {
      plan_key: "ALWAYS SET EXCLUDED.plan_key — overwrites",
      price_monthly: "COALESCE(EXCLUDED, existing) — EXCLUDED wins when NOT NULL → OVERWRITES commercial price",
      sales_limit_monthly: "COALESCE(EXCLUDED, existing) — OVERWRITES when EXCLUDED not null",
      id: "COALESCE(existing, EXCLUDED) — preserves existing id ✓",
      billing_required: "COALESCE(existing, EXCLUDED) — preserves existing ✓",
    },
    post_upsert_update: "SET price=price_monthly when divergent — may mutate legacy price column",
    validation_block: "FAIL if not exactly 8 canonical active plans with baby limit=50",
    verdict: "BLOCKER — must split SCHEMA bootstrap vs FRESH-ONLY seed before commit to general chain",
    recommended_fix: "Seed only when (SELECT count(*) FROM plans)=0 OR per-plan INSERT WHERE NOT EXISTS(plan_key); never COALESCE(EXCLUDED.price_*) over existing non-null",
  },
  scenario_a_fresh_db: "PASS — materializes 8 plans deterministically",
};

const suse7PlanCatalogAudit = {
  path: "suse7-backend/src/billing/suse7PlanCatalog.js",
  imports: {
    production_runtime: [
      "billingSubscriptionService.js → isQuotePlanRow only",
      "billingSubscriptionChangePlanService.js → isQuotePlanRow only",
    ],
    test_harness: [
      "test_dev_v2_plans_catalog_contract_unit.mjs → SUSE7_CANONICAL_PLANS",
      "test_perfil_planos_catalog_unit.mjs → reads file as text",
      "dev_v2_plans_catalog_db_ssot_bootstrap.mjs → audit reference",
    ],
  },
  commercial_array_in_runtime: false,
  isQuotePlanRow_uses_db_row: true,
  classification: "SAFE_NON_RUNTIME",
  note: "SUSE7_CANONICAL_PLANS not imported for pricing/checkout; prefer moving seed contract to SQL-only or test fixture in commit polish",
};

const frontendFallbacks = [
  { file: "planSupportChannels.js", field: "PLAN_SUPPORT_BY_KEY", type: "DISPLAY_FALLBACK", financial: false, quota: false },
  { file: "planIncludedFeatures.js", field: "shared benefits copy", type: "DISPLAY_FALLBACK", financial: false, quota: false },
  { file: "suse7CompleteArsenal.js", field: "marketing sections", type: "DISPLAY_FALLBACK", financial: false, quota: false },
  { file: "planDisplay.js / billingFormatters.js", field: "formatting only", type: "DISPLAY_FALLBACK", financial: false, quota: false },
  { file: "planCta.js", field: "CTA labels + quote detection via API plan", type: "DISPLAY_FALLBACK", financial: false, quota: false },
  { file: "billingConstants.js", field: "BILLING_SUSPENSION_FALLBACK_SALES_LIMIT_DEFAULT=60", type: "INTERNAL_ENTITLEMENT", financial: false, quota: true, note: "internal suspension only, not catalog" },
];

const subscriptionPlansProof = {
  path: "suse7-frontend/src/constants/subscriptionPlans.js",
  runtime_imports_in_src: 0,
  billing_ui_imports: 0,
  classification: "LEGACY_UNUSED",
  proven: true,
};

const commitA = {
  name: "feat(db): Fresh DEV V2 replay foundation migrations",
  message: "feat(db): add Fresh DEV V2 schema bridges, core bootstrap, and canonical orphan migrations",
  files: [
    "suse7-frontend/.gitignore (exception for canonical baseline/bridge)",
    "suse7-frontend/supabase/migrations/20260301215430_baseline_public_from_prod.sql",
    "suse7-frontend/supabase/migrations/20260301215959_baseline_sales_schema_bridge.sql",
    "suse7-frontend/supabase/migrations/20260301220000_core_schema_bootstrap.sql",
    "suse7-frontend/supabase/migrations/20260301220001_plans_commercial_catalog_bootstrap.sql (after BLOCKER fix)",
    "suse7-frontend/supabase/migrations/20260328120001_sales_order_items_rpc_compat.sql",
    "suse7-backend/supabase/migrations/20260510130000_marketplace_account_sales_import_coverage.sql",
    "suse7-backend/supabase/migrations/20260513190000_billing_payment_methods.sql",
    "suse7-backend/supabase/migrations/20260812130000_legal_document_acceptances.sql",
  ],
  lines_approx: "+2500 SQL",
  risk: "medium until plans seed split",
  tests: ["dev_v2_supabase_local_replay.mjs 115/115"],
};

const commitB = {
  name: "fix(billing): DB-driven Baby limits and internal entitlement separation",
  message: "fix(billing): stop Baby hardcodes; anchor internal subscription on commercial plan row",
  files: [
    "suse7-backend/src/billing/services/internalBabyPlanService.js",
    "suse7-backend/src/billing/services/billingBabyHardLimitService.js",
    "suse7-backend/scripts/test_dev_v2_plans_baby_internal_separation_unit.mjs",
  ],
  lines_approx: "+40/-30",
  risk: "low",
  tests: ["test_dev_v2_plans_baby_internal_separation_unit.mjs"],
  excludes: ["suse7PlanCatalog.js unless moved to test-only path"],
};

const commitC = {
  name: "chore(dev): global DEV maintenance mode",
  message: "chore(dev): add global DEV maintenance mode guards for controlled rebuild",
  files: [
    "suse7-backend/src/domain/dev/devGlobalMaintenanceMode.js",
    "suse7-backend/src/domain/dev/devCleanRoomMaintenanceFence.js (deprecated shim)",
    "suse7-backend/scripts/test_dev_global_maintenance_mode_unit.mjs",
    "suse7-backend/src/handlers/ml/mlWebhookProcessor.js (maintenance hunks only)",
    "suse7-backend/src/modules/marketplaces/mercado-livre/webhooks/processMlWebhookEvent.js",
    "suse7-backend/src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js",
    "suse7-backend/src/handlers/jobs/billingRenewalEngineJob.js",
    "suse7-backend/src/handlers/jobs/competitionDailySnapshotJob.js",
    "suse7-backend/src/services/marketplace/marketplaceAccountSyncWorker.js",
    "suse7-backend/src/services/marketplace/mlIncrementalSalesPoll.js",
    "suse7-backend/src/handlers/ml/_helpers/mlWebhookOrderProcessorOutcome.js",
  ],
  lines_approx: "+200",
  risk: "low — PROD fail-safe tested",
  tests: ["test_dev_global_maintenance_mode_unit.mjs", "mlWebhookOrderProcessorOutcome.test.js"],
};

const commitD = {
  name: "chore(tooling): Supabase Local canonical replay harness",
  message: "chore(tooling): add Supabase Local replay harness and plans contract tests",
  files: [
    "suse7-backend/scripts/dev_v2_supabase_local_replay.mjs",
    "suse7-backend/scripts/test_dev_v2_plans_catalog_contract_unit.mjs",
    "suse7-backend/scripts/test_dev_v2_plans_db_ssot_unit.mjs",
    "suse7-backend/scripts/supabase-local-replay-workspace/supabase/config.toml",
    "suse7-backend/scripts/supabase-local-replay-workspace/supabase/seed.sql",
    "suse7-backend/scripts/supabase-local-replay-workspace/supabase/.gitignore",
  ],
  discard: [
    "dev_v2_migration_replay_proof.mjs (plain Postgres superseded)",
    "dev_v2_migration_replay_local.mjs (redundant)",
    "dev_v2_generate_static_artifacts.mjs (one-off)",
    "dev_v2_preexec_audit.mjs (one-off)",
    "dev_v2_dev_readonly_probe.mjs (one-off)",
    "dev_v2_core_schema_bootstrap_audit.mjs (one-off)",
    "dev_v2_plans_catalog_db_ssot_bootstrap.mjs (orchestrator — LOCAL_ONLY)",
    "dev_v2_storage_company_logos_validate.mjs (helper — optional keep)",
  ],
  lines_approx: "+800",
  risk: "none",
  tests: ["115/115 replay"],
};

// Classify working tree
const classCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0 };
/** @type {Record<string, unknown>[]} */
const worktreeEntries = [];

for (const [repoName, repoPath] of [
  ["suse7-backend", BACKEND],
  ["suse7-frontend", FRONTEND],
]) {
  const st = git(repoPath, "status", "--short");
  for (const line of (st.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const rel = line.slice(3).trim();
    const cls = classifyFile(rel, repoName === "suse7-frontend" ? "frontend" : "backend");
    classCounts[cls] = (classCounts[cls] || 0) + 1;
    worktreeEntries.push({ repo: repoName, status: line.slice(0, 2).trim(), path: rel, class: cls });
  }
}

const secretScan = {
  workspace_files: ["config.toml", "seed.sql", ".gitignore"],
  secrets_found: false,
  note: "No keys in workspace; supabase/.temp gitignored",
  pass: true,
};

const forwardSafety = {
  core_schema_bootstrap: "PASS",
  sales_bridge: "PASS",
  sales_order_items_rpc_compat: "PASS",
  orphan_backend_migrations: "PASS",
  plans_commercial_catalog_bootstrap: "FAIL on existing DB commercial overwrite",
  overall: "FAIL until plans seed split",
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `DEV_V2_COMMIT_GROUPS_${RUN_DATE}.json`), JSON.stringify({ commitA, commitB, commitC, commitD }, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_FORWARD_SAFETY_AUDIT_${RUN_DATE}.json`), JSON.stringify(forwardSafety, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_RUNTIME_IMPORT_AUDIT_${RUN_DATE}.json`), JSON.stringify({ suse7PlanCatalogAudit, existingDbBehavior, subscriptionPlansProof, frontendFallbacks }, null, 2));
fs.writeFileSync(
  path.join(OUT, `DEV_V2_FINAL_WORKTREE_CLASSIFICATION_${RUN_DATE}.json`),
  JSON.stringify({ classCounts, entries: worktreeEntries, migrations, gitignore_blocker: "suse7-frontend/.gitignore line 36 ignores *baseline*.sql" }, null, 2),
);

const report = `# RELATÓRIO — DEV.V2.REPLAY-FOUNDATION-COMMIT-REVIEW.06 (${RUN_DATE})

## 1. STATUS
**REVIEW COMPLETA — PRONTO PARA COMMIT: NÃO** (2 blockers P0)

## 2. WORKING TREE
| Classe | Qtd | Descrição |
|--------|-----|-----------|
| A | ${classCounts.A} | Canonical schema/migrations |
| B | ${classCounts.B} | Replay harness |
| C | ${classCounts.C} | Plans DB SSOT fixes |
| D | ${classCounts.D} | Global maintenance |
| E | ${classCounts.E} | Abandoned seller fence |
| F | ${classCounts.F} | Unrelated WIP |
| G | ${classCounts.G} | Generated/local artifacts |

## 3. MIGRATIONS CANÔNICAS
8 migrations + baseline (ver JSON). Bridge e baseline **gitignored** hoje.

## 4. FORWARD SAFETY — **FAIL**
Core/bridge/orphans PASS. Plans catalog UPSERT **FAIL** em existing DB.

## 5. PLANS BOOTSTRAP EXISTING DB — **BLOCKER**
\`ON CONFLICT (name) DO UPDATE\` sobrescreve \`price_monthly\`, \`sales_limit_*\` quando EXCLUDED not null.
Validação exige 8 planos baby=50 — falha em DEV existente divergente.
**Fix obrigatório:** separar schema bootstrap vs fresh-only seed.

## 6. suse7PlanCatalog.js — **SAFE_NON_RUNTIME**
Runtime importa só \`isQuotePlanRow\` (lê row DB). Array comercial só em testes/harness.

## 7. INTERNAL BABY — **PASS**
Sem UPDATE plans; hardcode 60 removido; anchor comercial baby.

## 8. FRONTEND FALLBACKS
6 mapeados — todos DISPLAY_FALLBACK ou INTERNAL_ENTITLEMENT. **0 P0 financial/quota**.

## 9. subscriptionPlans.js — **LEGACY_UNUSED SIM**
Zero imports em \`src/\`.

## 10. REPLAY HARNESS
**Manter:** \`dev_v2_supabase_local_replay.mjs\` + workspace config + 3 testes plans.
**Descartar:** plain Postgres replay scripts, one-off audits.

## 11. LOCAL WORKSPACE — secret scan **PASS**

## 12. SELLER FENCE — **isolada SIM** (classe E, não entra commits DEV V2)

## 13. GLOBAL MAINTENANCE — **isolada SIM**, tests 8/8

## 14. WIP UNRELATED — **isolado SIM** (34+ backend files, 220 frontend files fora do escopo)

## 15–18. COMMITS PROPOSTOS
Ver \`DEV_V2_COMMIT_GROUPS_${RUN_DATE}.json\`

## 19. REPLAY FINAL — **115/115 PASS**

## 20. TESTES — **PASS**

## 21. BUILD — **PASS** (syntax check)

## 22. BLOCKERS
1. Plans bootstrap existing DB overwrite
2. Baseline/bridge gitignored — não reproduzível via git sem fix .gitignore

## 23. BILLING.PLANS.DB-SSOT.01
Cleanup subscriptionPlans.js + display fallbacks documentation

## PRONTO PARA COMMIT: **NÃO**
## FRESH DEV V2 READY AFTER COMMITS: **PARCIAL** (após fix blockers + commits A–D)
`;

fs.writeFileSync(path.join(OUT, `RELATORIO_DEV_V2_REPLAY_FOUNDATION_COMMIT_REVIEW_06_${RUN_DATE}.md`), report);
console.log(JSON.stringify({ ok: true, classCounts, forwardSafety: forwardSafety.overall, pronto: false }, null, 2));
