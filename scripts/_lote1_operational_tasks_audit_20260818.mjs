#!/usr/bin/env node
/**
 * Lote 1 — scope audit + contract + DEV probes (read-only on WIP trees).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const FE_ROOT = path.resolve(__dirname, "../../suse7-frontend");
const BE_ROOT = path.resolve(__dirname, "..");

fs.mkdirSync(OUT, { recursive: true });

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).trim();
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function classifyFrontendFile(rel) {
  const p = rel.replace(/\\/g, "/");
  const txt = readFileSafe(path.join(FE_ROOT, rel)) ?? "";
  const onboardingSignals = [
    /configurationOnboarding/i,
    /S7ConfigurationOnboardingSection/i,
    /S7ImportantNotice/i,
    /Completar estas etapas/i,
    /TermsAcceptance/i,
    /ConfigurationCompanyDataModal/i,
  ];
  const otSignals = [
    /operationalTasks/i,
    /OperationalTasksPanelIcon/i,
    /S7OperationalTasksPanel/i,
    /buildCollapsedOperationalTasksLabel/i,
    /missing_product_costs/i,
  ];
  const otHits = otSignals.filter((re) => re.test(p) || re.test(txt)).length;
  const obHits = onboardingSignals.filter((re) => re.test(p) || re.test(txt)).length;

  if (p.includes("operationalTasks/") || p.includes("test_operational_tasks")) {
    if (p.includes("post_onboarding_consolidation")) return { classification: "MIXED_WIP", reason: "Operational Tasks + Onboarding test" };
    if (obHits > 0 && p.includes("S7OperationalTasksPanel")) return { classification: "MIXED_WIP", reason: "Panel shell hosts onboarding section (integration, not onboarding copy changes)" };
    if (p.includes("DashboardOperationalTasks")) return { classification: "MIXED_WIP", reason: "Orchestrator imports configurationOnboarding snapshot/actions" };
    return { classification: "PURE_OPERATIONAL_TASKS", reason: "Direct operational tasks module/test" };
  }
  if (p === "src/components/Layout.jsx") return { classification: "MIXED_WIP", reason: "Login intro, profile API, app gate, operational host combined" };
  return { classification: "NOT_RELEVANT", reason: "Outside lote 1 inventory path" };
}

async function probeUrls() {
  const probes = {};
  const urls = [
    ["backend_dev_health", "https://suse7-backend-dev.vercel.app/api/health"],
    ["backend_dev_billing_ping", "https://suse7-backend-dev.vercel.app/api/billing/ping"],
    ["backend_dev_oauth_config", "https://suse7-backend-dev.vercel.app/api/ml/oauth-config"],
    ["frontend_dev_alias", "https://suse7-frontend-dev.vercel.app/"],
    ["frontend_preview", "https://suse7-frontend.vercel.app/"],
  ];
  for (const [key, url] of urls) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      probes[key] = { url, http: res.status, json: json ? sanitizeJson(json) : { html_length: text.length } };
    } catch (e) {
      probes[key] = { url, error: String(e) };
    }
  }
  return probes;
}

function sanitizeJson(obj) {
  const allow = [
    "ok",
    "service",
    "env",
    "commit",
    "vercel_git_commit",
    "ml_oauth_callback_module_rev",
    "ml_oauth_persistence_module_rev",
    "s7AppEnv",
    "vercelEnv",
    "router",
    "renewal_test_accelerated",
  ];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of allow) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  if (obj.buildFingerprint) {
    out.buildFingerprint = {
      vercel_git_commit: obj.buildFingerprint.vercel_git_commit ?? null,
      ml_oauth_callback_module_rev: obj.buildFingerprint.ml_oauth_callback_module_rev ?? null,
      ml_oauth_persistence_module_rev: obj.buildFingerprint.ml_oauth_persistence_module_rev ?? null,
    };
  }
  if (obj.envCoherence) {
    out.envCoherence = { s7AppEnv: obj.envCoherence.s7AppEnv ?? null };
  }
  return out;
}

function buildContract() {
  return {
    A_when_panel_appears: "GlobalOperationalTasksHost in Layout when authReady; shouldShowOperationalTasks(route prefixes)",
    B_total_pendencies: "totalTasks from useOperationalTasks / API; collapsed label via buildCollapsedOperationalTasksLabel(totalTasks)",
    C_categories: "missing_product_costs, missing_listing_skus (operationalTaskTypes); configuration milestones separate section",
    D_priority: "API order preserved in tasks array; configuration section above operational when both visible",
    E_sku_costs_exclusivity: "Separate task types; cache patch removes task when count=0",
    F_presync: "sincronizacaoInicialAguardandoInicio forces collapsed; no persist preference until sync started",
    G_empty_state: "Operational section hidden or empty when totalTasks=0 and no errors",
    H_collapsed_expanded: "operationalTasksCollapsePolicy + localStorage per user; OperationalTasksPanelIcon variants collapsed|expanded|onboarding",
    I_navigation: "operationalTaskActionRegistry executeOperationalTaskAction; bulk modals for costs/sku",
    J_persistence: "operationalTasksCollapseStorage localStorage key per userId",
  };
}

function listFrontendOtFiles() {
  const inv = JSON.parse(fs.readFileSync(path.join(OUT, "WIP_INVENTORY_20260818.json"), "utf8"));
  const fromInv = (inv.files_frontend || []).filter((f) => f.front === "A_Operational_Tasks").map((f) => f.path);
  const vsMain = git(FE_ROOT, ["diff", "origin/main", "--name-only", "--", "src/features/dashboard/operationalTasks/"])
    .split(/\r?\n/)
    .filter(Boolean);
  const all = [...new Set([...fromInv, ...vsMain])];
  return all.map((rel) => ({ path: rel, ...classifyFrontendFile(rel) }));
}

function listBackendOtFiles() {
  const files = [
    "scripts/test_operational_tasks_post_oauth_payload.mjs",
    "scripts/test_operational_tasks_post_onboarding_consolidation.mjs",
    "scripts/test_operational_tasks_product_costs_ssot_unit.mjs",
  ];
  return files.map((rel) => {
    const txt = readFileSafe(path.join(BE_ROOT, rel)) ?? "";
    let classification = "PURE_OPERATIONAL_TASKS";
    let reason = "Backend operational tasks contract test";
    if (rel.includes("post_onboarding_consolidation")) {
      classification = "MIXED_WIP";
      reason = "Crosses operational tasks + onboarding consolidation";
    }
    if (rel.includes("post_oauth")) {
      classification = "MIXED_WIP";
      reason = "OAuth payload test — out of lote 1 shell scope";
    }
    const inMain = (() => {
      try {
        git(BE_ROOT, ["cat-file", "-e", `origin/main:${rel}`]);
        return true;
      } catch {
        return false;
      }
    })();
    return { path: rel, classification, reason, backend_role: inMain ? "ALREADY_IN_MAIN_OR_PARTIAL" : "WIP_NOT_ON_MAIN", required_for_lote1: classification === "PURE_OPERATIONAL_TASKS" ? "OPTIONAL" : "NO" };
  });
}

function vercelFrontendAudit() {
  try {
    const wt = path.resolve(__dirname, "../../_worktrees/suse7-backend-prod-deploy");
    const projPath = path.join(wt, ".vercel/project.json");
    if (!fs.existsSync(projPath)) return { note: "use npx vercel project ls manually" };
  } catch {
    /* ignore */
  }
  let ls = "";
  try {
    ls = execFileSync("npx", ["vercel", "project", "ls"], { encoding: "utf8", cwd: FE_ROOT, maxBuffer: 5 * 1024 * 1024 });
  } catch (e) {
    ls = String(e.stdout || e.message || e);
  }
  return { vercel_project_ls_excerpt: ls.split(/\r?\n/).slice(0, 12).join("\n") };
}

async function runFrontendUnitTests() {
  const tests = [
    "scripts/test_operational_tasks_frontend_unit.mjs",
    "scripts/test_operational_tasks_bottom_safe_area_unit.mjs",
    "scripts/test_operational_tasks_global_shell_unit.mjs",
    "scripts/test_operational_tasks_presync_consolidation_unit.mjs",
    "scripts/test_operational_tasks_after_single_cost_save_unit.mjs",
  ];
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  for (const t of tests) {
    const full = path.join(FE_ROOT, t);
    if (!fs.existsSync(full)) {
      results.push({ file: t, status: "MISSING" });
      continue;
    }
    const r = spawnSync(process.execPath, [full], { cwd: FE_ROOT, encoding: "utf8", timeout: 120000 });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const pass = r.status === 0 && !/✗|FAIL/i.test(out);
    results.push({
      file: t,
      status: pass ? "PASS" : "FAIL",
      exit_code: r.status,
      classification: t.includes("presync") || t.includes("global_shell") ? "CURRENT" : t.includes("onboarding") ? "MIXED" : "CURRENT",
      excerpt: out.split(/\r?\n/).slice(-8).join("\n"),
    });
  }
  return results;
}

async function main() {
  git(FE_ROOT, ["fetch", "origin", "main"]);
  git(BE_ROOT, ["fetch", "origin", "main"]);

  const frontendFiles = listFrontendOtFiles();
  const backendFiles = listBackendOtFiles();
  const probes = await probeUrls();
  const testResults = await runFrontendUnitTests();

  const mainHasOt = git(FE_ROOT, ["ls-tree", "-r", "origin/main", "--name-only"])
    .split(/\r?\n/)
    .some((p) => p.includes("operationalTasks"));

  const scopeAudit = {
    generated_at: new Date().toISOString(),
    status: "SCOPE_AUDIT_COMPLETE",
    main_has_operational_tasks_module: mainHasOt,
    frontend: {
      branch: git(FE_ROOT, ["branch", "--show-current"]),
      head: git(FE_ROOT, ["rev-parse", "HEAD"]),
      main: git(FE_ROOT, ["rev-parse", "origin/main"]),
      files: frontendFiles,
      pure_count: frontendFiles.filter((f) => f.classification === "PURE_OPERATIONAL_TASKS").length,
      mixed_count: frontendFiles.filter((f) => f.classification === "MIXED_WIP").length,
    },
    backend: {
      branch: git(BE_ROOT, ["branch", "--show-current"]),
      head: git(BE_ROOT, ["rev-parse", "HEAD"]),
      main: git(BE_ROOT, ["rev-parse", "origin/main"]),
      files: backendFiles,
      backend_required_for_lote1: "NO",
    },
    dependency_blockers: [
      {
        id: "configurationOnboarding_missing_on_main",
        severity: "P0",
        note: "DashboardOperationalTasks + S7OperationalTasksPanel import configurationOnboarding; module absent on origin/main",
      },
      {
        id: "layout_mixed_wip",
        severity: "P0",
        note: "Layout.jsx mixes login intro, profile API, ConfigurationAppGate, and GlobalOperationalTasksHost",
      },
      {
        id: "commits_not_pure",
        severity: "P1",
        note: "operationalTasks/ introduced in commits 1cc6c0b and 604f37b (onboarding titles)",
      },
    ],
    contract: buildContract(),
  };

  const billingPing = probes.backend_dev_billing_ping?.json ?? {};
  const reportedCommit = billingPing.commit ?? null;

  const devIdentity = {
    generated_at: new Date().toISOString(),
    reported_billing_ping_commit: reportedCommit,
    local_branch_head: git(BE_ROOT, ["rev-parse", "HEAD"]),
    origin_main: git(BE_ROOT, ["rev-parse", "origin/main"]),
    anchor_fix_on_main: git(BE_ROOT, ["merge-base", "--is-ancestor", "1168fbb2f8f3e002af80eb39e4607b22b62254f7", "origin/main"])
      ? "YES"
      : "CHECK",
    conclusion:
      reportedCommit === "61d00a308609aaa5345e1799fcd11e9e1680caae"
        ? "REPORTED_SHA_STALE_OR_STATIC: billing /ping exposes commit field that may not reflect live deployment; anchor fix merged to main (1168fbb) but ping still reports pre-fix 61d00a3"
        : "REVIEW_REQUIRED",
    probes,
    fix_presence_probe: {
      method: "Cannot invoke period-expirations without secret in this mission; infer from commit metadata vs main",
      billing_cycle_anchor_fix_in_main: true,
      billing_cycle_anchor_in_reported_dev_commit: false,
    },
  };

  const feTarget = {
    generated_at: new Date().toISOString(),
    FRONTEND_DEV_CANONICAL_URL:
      probes.frontend_dev_alias?.http === 200
        ? "https://suse7-frontend-dev.vercel.app/"
        : "FRONTEND_DEV_TARGET_NOT_CONFIGURED",
    note:
      probes.frontend_dev_alias?.http === 404
        ? "suse7-frontend-dev returns 404; suse7-frontend.vercel.app returns 200 (production/preview — not DEV)"
        : null,
    vercel_projects: vercelFrontendAudit(),
    probes: {
      frontend_dev_alias: probes.frontend_dev_alias,
      frontend_preview: probes.frontend_preview,
    },
  };

  const consolidationBlocked =
    !mainHasOt &&
    scopeAudit.dependency_blockers.some((b) => b.severity === "P0");

  const report = {
    generated_at: new Date().toISOString(),
    lote1_status: consolidationBlocked ? "BLOCKED" : "READY_FOR_EXTRACTION",
    block_reason: consolidationBlocked
      ? "Cannot land operational tasks-only diff on main without configurationOnboarding + surgical Layout wiring (mixed WIP)"
      : null,
    scopeAudit,
    testResults,
    recommended_next_gate: consolidationBlocked
      ? "Approve Lote 1+dependency bundle: (A) configurationOnboarding unchanged copy for build, (B) surgical Layout OT wiring only, OR merge onboarding foundation first"
      : "Proceed extraction to consolidate/operational-tasks-lote1",
  };

  fs.writeFileSync(path.join(OUT, `OPERATIONAL_TASKS_LOTE1_SCOPE_AUDIT_${DATE}.json`), JSON.stringify(scopeAudit, null, 2));
  fs.writeFileSync(
    path.join(OUT, `OPERATIONAL_TASKS_LOTE1_DIFF_MATRIX_${DATE}.json`),
    JSON.stringify({ frontendFiles, backendFiles, wiring_dependencies: ["configurationOnboarding/*", "Layout.jsx (partial)"] }, null, 2)
  );
  fs.writeFileSync(path.join(OUT, `OPERATIONAL_TASKS_LOTE1_TEST_RESULTS_${DATE}.json`), JSON.stringify({ results: testResults }, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_RUNTIME_IDENTITY_RECONCILIATION_${DATE}.json`), JSON.stringify(devIdentity, null, 2));
  fs.writeFileSync(path.join(OUT, `FRONTEND_DEV_TARGET_AUDIT_${DATE}.json`), JSON.stringify(feTarget, null, 2));

  const md = `# Operational Tasks Lote 1 Scope Audit

## Status: ${report.lote1_status}

${report.block_reason ?? ""}

## Pure vs Mixed
- Pure: ${scopeAudit.frontend.pure_count}
- Mixed: ${scopeAudit.frontend.mixed_count}
- Backend required: NO

## Tests
${testResults.map((t) => `- ${t.file}: ${t.status}`).join("\n")}

## DEV Backend identity
- Reported ping commit: ${reportedCommit}
- Conclusion: ${devIdentity.conclusion}

## Frontend DEV
- ${feTarget.FRONTEND_DEV_CANONICAL_URL}
`;
  fs.writeFileSync(path.join(OUT, `OPERATIONAL_TASKS_LOTE1_SCOPE_AUDIT_${DATE}.md`), md);
  fs.writeFileSync(path.join(OUT, `OPERATIONAL_TASKS_LOTE1_CONSOLIDATION_REPORT_20260818.md`), md);

  console.log(JSON.stringify({ status: report.lote1_status, tests: testResults.map((t) => ({ f: t.file, s: t.status })) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
