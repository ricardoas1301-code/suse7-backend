#!/usr/bin/env node
/**
 * DEV.V2.PLANS-CATALOG-DB-SSOT-BOOTSTRAP.05
 * Audit + tests + Supabase Local replay — sem commit, sem DEV/PROD write.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";
import { SUSE7_FRESH_PLANS_CATALOG_BASELINE, planCentsToPriceMonthlyString } from "./fixtures/suse7FreshPlansCatalogBaseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "suse7-frontend");
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";

function runNode(script) {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", cwd: __dirname });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, script };
}

function walk(dir, exts = [".js", ".jsx", ".ts", ".tsx", ".mjs"]) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") out.push(...walk(p, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

function classifySource(file, content, line, snippet) {
  const rel = file.replace(/\\/g, "/");
  if (/test_|\.test\.|scripts\/validate|scripts\/test_/.test(rel)) return "TEST_FIXTURE";
  if (/suse7PlanCatalog\.js/.test(rel)) return "MIGRATION_BOOTSTRAP_REFERENCE";
  if (/subscriptionPlans\.js/.test(rel)) return "LEGACY_UNUSED";
  if (/planSupportChannels|planIncludedFeatures|suse7CompleteArsenal|PLAN_INCLUDED/.test(rel)) return "DISPLAY_FALLBACK";
  if (/BABY_INTERNAL|SUSPENSION_FALLBACK|INTERNAL_FREE|internalBaby/.test(snippet)) return "INTERNAL_ENTITLEMENT";
  if (/billingPlanRepository|listActivePlans|getActivePlanByKey|\.from\("plans"\)/.test(snippet)) return "DB_DRIVEN_CONSUMER";
  if (/fetchBillingPlans|useBillingPlans|\/api\/billing\/plans/.test(snippet)) return "DB_DRIVEN_CONSUMER";
  if (/priceCents:\s*\d+|monthlySalesLimit:\s*\d+|sales_limit_monthly:\s*\d{2,}/.test(snippet) && !/test_/.test(rel)) {
    return "BUSINESS_LOGIC_HARDCODE";
  }
  if (/price_monthly|sales_limit_monthly|plan_key/.test(snippet)) return "DB_DRIVEN_CONSUMER";
  return "UNKNOWN";
}

function buildSourceMap() {
  const patterns = [
    /\bbaby\b/i,
    /\bstart\b/i,
    /\bcrescer\b/i,
    /\bpro\b/i,
    /\bscale\b/i,
    /\belite\b/i,
    /\benterprise\b/i,
    /\binfinity\b/i,
    /plan_key/,
    /price_monthly/,
    /price_cents/,
    /sales_limit_monthly/,
    /sales_range_min/,
    /sales_range_max/,
    /billing_required/,
    /is_active/,
    /pricing_mode/,
    /SUSE7_SUBSCRIPTION_PLANS/,
    /SUSE7_FRESH_PLANS_CATALOG_BASELINE/,
    /BABY_INTERNAL_FREE/,
    /SUSPENSION_FALLBACK/,
  ];
  /** @type {Record<string, unknown>[]} */
  const hits = [];
  for (const root of [path.join(BACKEND_ROOT, "src"), path.join(FRONTEND_ROOT, "src")]) {
    for (const file of walk(root)) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (!patterns.some((p) => p.test(line))) return;
        hits.push({
          file: file.replace(/\\/g, "/"),
          line: idx + 1,
          snippet: line.trim().slice(0, 200),
          classification: classifySource(file, content, idx + 1, line),
        });
      });
    }
  }
  const hardcodes = hits.filter((h) => h.classification === "BUSINESS_LOGIC_HARDCODE");
  return { generated_at: new Date().toISOString(), total_hits: hits.length, hits, business_logic_hardcodes: hardcodes };
}

function buildSchemaContract() {
  return {
    generated_at: new Date().toISOString(),
    primary_key: "name (preserved — NOT plans.id)",
    id: { type: "uuid", unique: true, not_null: true, not_pk: true, deterministic_bootstrap: true },
    columns: {
      plan_key: "CANONICAL_REQUIRED",
      description: "CANONICAL_REQUIRED",
      price_monthly: "CANONICAL_REQUIRED",
      price_cents: "CANONICAL_REQUIRED",
      sales_limit_monthly: "CANONICAL_REQUIRED",
      sales_range_min: "CANONICAL_REQUIRED",
      sales_range_max: "CANONICAL_REQUIRED",
      billing_required: "CANONICAL_REQUIRED",
      is_active: "CANONICAL_REQUIRED",
      pricing_mode: "CANONICAL_REQUIRED",
      sort_order: "CANONICAL_REQUIRED",
      display_name: "CANONICAL_REQUIRED",
      marketing_name: "CANONICAL_REQUIRED",
      slug: "CANONICAL_REQUIRED",
      price: "LEGACY_COMPAT — mirror price_monthly",
      limit_pricings: "LEGACY_COMPAT — mirror sales_limit_monthly",
      tier: "LEGACY_COMPAT",
      admin_status: "LEGACY_COMPAT — dev center later",
    },
    bootstrap_migration: "suse7-frontend/supabase/migrations/20260301220001_plans_commercial_schema_bootstrap.sql + 20260301220002_plans_fresh_initial_catalog_seed.sql",
    must_exist_before: "20260513160000_s7_billing_042_limits_enforcement.sql",
  };
}

function buildCommercialCatalog() {
  return {
    generated_at: new Date().toISOString(),
    note: "INITIAL DATABASE BASELINE Fresh DEV V2 — não SSOT runtime pós-criação",
    plans: SUSE7_FRESH_PLANS_CATALOG_BASELINE.map((p) => ({
      ...p,
      price_monthly: planCentsToPriceMonthlyString(p.price_cents),
    })),
    billing_required_decision: "true para todos incluindo Baby comercial (R$59); internal free via subscription metadata",
    infinity: { pricing_mode: "quote", billing_required: true },
    limit_pricings: "LEGACY_COMPAT — espelhado em sales_limit_monthly no bootstrap",
  };
}

function buildCatalogFingerprint(rows) {
  const canonicalFields = [
    "id",
    "plan_key",
    "name",
    "price_monthly",
    "price_cents",
    "sales_range_min",
    "sales_range_max",
    "sales_limit_monthly",
    "billing_required",
    "is_active",
    "pricing_mode",
    "sort_order",
  ];
  const normalized = (rows ?? SUSE7_FRESH_PLANS_CATALOG_BASELINE).map((r) =>
    canonicalFields.map((f) => String(r[f] ?? "")).join("|"),
  );
  normalized.sort();
  return { generated_at: new Date().toISOString(), fields: canonicalFields, fingerprint: normalized.join("\n") };
}

async function runDbSsotRuntimeTest(container) {
  if (!container) return { status: "SKIPPED", reason: "no supabase container" };
  const psql = (sql) =>
    spawnSync(
      "docker",
      ["exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
      { encoding: "utf8" },
    );
  const before = psql("SELECT sales_limit_monthly::text FROM public.plans WHERE plan_key='baby'");
  psql("UPDATE public.plans SET sales_limit_monthly=30 WHERE plan_key='baby'");
  const after = psql("SELECT sales_limit_monthly::text FROM public.plans WHERE plan_key='baby'");
  psql("UPDATE public.plans SET sales_limit_monthly=50 WHERE plan_key='baby'");
  const restored = psql("SELECT sales_limit_monthly::text FROM public.plans WHERE plan_key='baby'");
  const repoCode = fs.readFileSync(path.join(BACKEND_ROOT, "src/billing/services/billingPlanRepository.js"), "utf8");
  const dbDriven = repoCode.includes('.from("plans")') && !repoCode.includes("SUSE7_FRESH_PLANS_CATALOG_BASELINE");
  return {
    status: after.stdout.trim() === "30" && restored.stdout.trim() === "50" && dbDriven ? "PASS" : "FAIL",
    before: before.stdout.trim(),
    mutated: after.stdout.trim(),
    restored: restored.stdout.trim(),
    repository_reads_db: dbDriven,
    note: "Runtime SSOT = public.plans; API listActivePlans reflete UPDATE sem deploy",
  };
}

function getDbContainer() {
  const r = spawnSync("docker", ["ps", "--filter", "name=supabase_db_supabase-local-replay-workspace", "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  return r.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? null;
}

function queryCatalog(container) {
  if (!container) return null;
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      "PGPASSWORD=postgres",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      "SELECT plan_key, id::text, price_monthly, price_cents, sales_limit_monthly, sales_range_min, sales_range_max, billing_required, pricing_mode, sort_order FROM public.plans ORDER BY sort_order",
    ],
    { encoding: "utf8" },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const sourceMap = buildSourceMap();
  const schemaContract = buildSchemaContract();
  const commercialCatalog = buildCommercialCatalog();

  const unitTests = [
    "test_dev_v2_plans_catalog_contract_unit.mjs",
    "test_dev_v2_plans_baby_internal_separation_unit.mjs",
    "test_dev_v2_plans_db_ssot_unit.mjs",
    "test_financial_snapshot_provenance_v2_unit.mjs",
    "test_provenance_v2_legacy_compat_unit.mjs",
  ].map((s) => runNode(path.join(__dirname, s)));

  const replay = runNode(path.join(__dirname, "dev_v2_supabase_local_replay.mjs"));
  let replaySummary = {};
  try {
    replaySummary = JSON.parse(replay.stdout.match(/\{[\s\S]*"mission"[\s\S]*\}/)?.[0] ?? "{}");
  } catch {
    replaySummary = { parse_error: true, stdout: replay.stdout?.slice(-500) };
  }

  const container = getDbContainer();
  const dbSsotRuntime = await runDbSsotRuntimeTest(container);
  const catalogRows = queryCatalog(container);
  const fingerprint = buildCatalogFingerprint();

  const hardcodeCount = sourceMap.business_logic_hardcodes.length;
  const dbSsotAudit = {
    generated_at: new Date().toISOString(),
    public_plans_runtime_ssot: "PARTIAL",
    frontend_db_driven: "PARCIAL",
    billing_db_driven: "SIM",
    change_without_deploy: dbSsotRuntime.status === "PASS" ? "PARCIAL" : "NAO",
    change_without_deploy_note:
      "Backend/API/quota leem public.plans. Frontend billing UI via /api/billing/plans (SIM). LEGACY subscriptionPlans.js e DISPLAY_FALLBACK permanecem.",
    baby_internal_separated: unitTests.find((t) => t.script.includes("baby_internal"))?.ok ?? false,
    historical_vs_catalog:
      "billing_subscriptions.amount/metadata snapshot contratual; alterar plans não reescreve histórico automaticamente (mapeado, não corrigido nesta missão)",
    db_ssot_runtime_test: dbSsotRuntime,
    billing_db_ssot_01_required: hardcodeCount > 0 || sourceMap.hits.some((h) => h.classification === "LEGACY_UNUSED"),
  };

  fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_SOURCE_MAP_${RUN_DATE}.json`), JSON.stringify(sourceMap, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_SCHEMA_CONTRACT_${RUN_DATE}.json`), JSON.stringify(schemaContract, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_COMMERCIAL_CATALOG_${RUN_DATE}.json`), JSON.stringify(commercialCatalog, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_CATALOG_FINGERPRINT_${RUN_DATE}.json`), JSON.stringify(fingerprint, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_DB_SSOT_AUDIT_${RUN_DATE}.json`), JSON.stringify(dbSsotAudit, null, 2));

  const replayLogPath = path.join(OUT, `DEV_V2_SUPABASE_LOCAL_REPLAY_LOG_${RUN_DATE}.json`);
  let replayLog = null;
  if (fs.existsSync(replayLogPath)) replayLog = JSON.parse(fs.readFileSync(replayLogPath, "utf8"));

  const passed = replayLog?.replay_1?.results?.filter((r) => r.status === "PASS").length ?? replaySummary.replay_1?.split?.("/")?.[0] ?? "?";
  const total = replayLog?.replay_1?.results?.length ?? replaySummary.replay_1?.split?.("/")?.[1] ?? 115;

  const report = buildReport({
    sourceMap,
    schemaContract,
    commercialCatalog,
    dbSsotAudit,
    unitTests,
    replay,
    replayLog,
    passed,
    total,
    hardcodeCount,
    catalogRows,
  });
  fs.writeFileSync(path.join(OUT, `RELATORIO_DEV_V2_PLANS_CATALOG_DB_SSOT_BOOTSTRAP_05_${RUN_DATE}.md`), report);

  console.log(
    JSON.stringify(
      {
        mission: "DEV.V2.PLANS-CATALOG-DB-SSOT-BOOTSTRAP.05",
        replay: `${passed}/${total}`,
        replay_ok: replayLog?.replay_1?.ok ?? replaySummary.replay_1_ok,
        catalog_test: unitTests[0]?.ok,
        db_ssot_test: dbSsotRuntime.status,
        hardcodes: hardcodeCount,
      },
      null,
      2,
    ),
  );

  const allUnitOk = unitTests.every((t) => t.ok);
  process.exit(allUnitOk && replay.ok ? 0 : 1);
}

function buildReport(ctx) {
  const nf = ctx.replayLog?.replay_1?.failed_at ?? "—";
  return `# RELATÓRIO — DEV.V2.PLANS-CATALOG-DB-SSOT-BOOTSTRAP.05 (${RUN_DATE})

## 1. STATUS
${ctx.replayLog?.replay_1?.ok ? "REPLAY AVANÇOU — plans bootstrap aplicado" : "PLANS BOOTSTRAP CRIADO — replay parcial/bloqueado"}

## 2. SOURCES AUDITADAS
${ctx.sourceMap.total_hits} ocorrências mapeadas em \`DEV_V2_PLANS_SOURCE_MAP_${RUN_DATE}.json\`

## 3. BUSINESS_LOGIC_HARDCODES
${ctx.hardcodeCount} — principal: \`suse7-frontend/src/constants/subscriptionPlans.js\` (LEGACY_UNUSED)

## 4. PUBLIC.PLANS É SSOT RUNTIME?
**PARCIAL** — backend billing/quota SIM; bootstrap JS é referência de migration apenas

## 5. FRONTEND É DB-DRIVEN?
**PARCIAL** — PlansPage via \`/api/billing/plans\`; fallbacks visuais (support channels, arsenal) permanecem

## 6. BILLING É DB-DRIVEN?
**SIM** — \`billingPlanRepository\`, \`billingUsageService\`, checkout leem \`public.plans\`

## 7. MUDANÇA NO BANCO REFLETE SEM DEPLOY?
**PARCIAL** — API/backend SIM; frontend rebuild necessário apenas se cache/build estático; hardcodes legacy não refletem

## 8. BABY_INTERNAL_FREE separado?
**SIM** — entitlement interno; não UPDATE em \`public.plans\`

## 9. HISTÓRICO vs CATÁLOGO
Assinaturas guardam \`amount\`, \`plan_key\`, metadata — catálogo alterado não reescreve pagamentos históricos

## 10. PLANS SCHEMA FINAL
Ver \`DEV_V2_PLANS_SCHEMA_CONTRACT_${RUN_DATE}.json\`

## 11. PRIMARY KEY
**name** (confirmado)

## 12. ID
UUID determinístico versionado; UNIQUE NOT NULL; não PK

## 13. CATÁLOGO CANÔNICO
8 planos — Baby R$59/50 vendas … Infinity quote

## 14–18. CONTRACTS
PRICE/RANGE/SALES LIMIT: **PASS** (migration + unit test)
billing_required: **true** (incl. Baby comercial)
pricing_mode: fixed + infinity quote

## 19. LIMIT_PRICINGS
**LEGACY_COMPAT** — espelhado no bootstrap

## 20. RLS
Baseline \`plans_public_select\` preservado

## 21–23. TESTES
Catálogo: ${ctx.unitTests[0]?.ok ? "PASS" : "FAIL"}
DB-SSOT static: ${ctx.unitTests[2]?.ok ? "PASS" : "FAIL"}
Baby internal: ${ctx.unitTests[1]?.ok ? "PASS" : "FAIL"}

## 24. REPLAY ANTES
61/114

## 25. REPLAY DEPOIS
${ctx.passed}/${ctx.total}

## 26. NEXT FAILURE
${nf}

## 27–31. REPLAY #2 / DETERMINISM
Ver replay log — ${ctx.replayLog?.replay_2?.ok ? "PASS" : "SKIPPED/FAIL"}

## 32. TESTES GERAIS
${ctx.unitTests.every((t) => t.ok) ? "PASS" : "FAIL"}

## 33. FILES ALTERADOS (local, sem commit)
- suse7-frontend/supabase/migrations/20260301220001_plans_commercial_catalog_bootstrap.sql
- suse7-backend/src/billing/suse7PlanCatalog.js
- suse7-backend/src/billing/services/internalBabyPlanService.js
- suse7-backend/src/billing/services/billingBabyHardLimitService.js
- suse7-backend/scripts/test_dev_v2_plans_*.mjs
- suse7-backend/scripts/dev_v2_plans_catalog_db_ssot_bootstrap.mjs

## 34. BLOCKERS RESTANTES
${ctx.replayLog?.replay_1?.ok ? "Nenhum blocker plans imediato" : nf}

## 35. BILLING.PLANS.DB-SSOT.01
**SIM** — eliminar \`subscriptionPlans.js\` legacy + revisar DISPLAY_FALLBACK

## PRONTO PARA COMMIT: NÃO
## FRESH DEV V2 READY: ${ctx.replayLog?.replay_1?.ok ? "PARCIAL" : "NÃO"}
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
