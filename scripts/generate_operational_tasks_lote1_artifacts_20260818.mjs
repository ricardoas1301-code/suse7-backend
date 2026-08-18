#!/usr/bin/env node
import { writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "output");
const WT = join(__dirname, "../../_clean-worktrees/suse7-frontend-lote1-ot");
const DATE = "20260818";

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const dependencyGraph = {
  generated_at: new Date().toISOString(),
  gate: "configurationOnboarding unchanged copy",
  verdict: "NOT_SAFE",
  nodes: [
    {
      from: "operationalTasks/DashboardOperationalTasks.jsx",
      import: "configurationOnboarding/*",
      classification: "ONBOARDING_BEHAVIOR_DEPENDENCY",
      lote1_action: "REMOVED — inert snapshot stub",
    },
    {
      from: "operationalTasks/S7OperationalTasksPanel.jsx",
      import: "S7ConfigurationOnboardingSection",
      classification: "ONBOARDING_BEHAVIOR_DEPENDENCY",
      lote1_action: "REMOVED",
    },
    {
      from: "operationalTasks/S7OperationalTasksPanel.jsx",
      import: "configurationOnboardingPanelState",
      classification: "RUNTIME_REQUIRED_BUT_NO_ONBOARDING_BEHAVIOR",
      lote1_action: "MOVED → operationalTasksPanelState.js",
    },
    {
      from: "Layout.jsx (WIP)",
      import: "ConfigurationAppGate",
      classification: "ONBOARDING_BEHAVIOR_DEPENDENCY",
      lote1_action: "EXCLUDED",
    },
  ],
};

const inertnessAudit = {
  generated_at: new Date().toISOString(),
  safe_dependency: false,
  items: {
    new_routes: { answer: "NO" },
    new_modals: { answer: "YES" },
    app_gate_behavior: { answer: "YES" },
    onboarding_appears: { answer: "YES" },
    terms_changes: { answer: "YES" },
    dados_loja_changes: { answer: "YES" },
    s7_important_notice: { answer: "NO" },
    copy_2_minutos: { answer: "YES" },
    existing_seller_functional_change: { answer: "YES" },
  },
  lote1_decision: "Did NOT copy configurationOnboarding/ package",
};

const layoutHunkMatrix = {
  generated_at: new Date().toISOString(),
  hunks: [
    { id: "imports_ot_host", include: true, reason: "OT shell" },
    { id: "configuration_app_gate", include: false, reason: "Lote 2" },
    { id: "global_ot_host_mount", include: true, reason: "OT host" },
    { id: "seller_company_provider", include: true, reason: "OT modal" },
  ],
};

const testFiles = [
  "scripts/test_operational_tasks_frontend_unit.mjs",
  "scripts/test_operational_tasks_bottom_safe_area_unit.mjs",
  "scripts/test_operational_tasks_global_shell_unit.mjs",
  "scripts/test_operational_tasks_presync_consolidation_unit.mjs",
  "scripts/test_operational_tasks_after_single_cost_save_unit.mjs",
  "scripts/test_operational_tasks_panel_icon_unit.mjs",
];

const testResults = { generated_at: new Date().toISOString(), tests: {}, mixed_excluded: [] };
for (const t of testFiles) {
  try {
    execSync(`node ${t}`, { cwd: WT, encoding: "utf8", stdio: "pipe" });
    testResults.tests[t] = { pass: true };
  } catch (e) {
    testResults.tests[t] = { pass: false, error: String(e.stderr || e.message).slice(0, 300) };
  }
}

let diffStat = {};
try {
  diffStat.raw = execSync("git diff --stat origin/main", { cwd: WT, encoding: "utf8" }).trim();
} catch (e) {
  diffStat.error = String(e.message);
}

writeFileSync(join(OUT, `OPERATIONAL_TASKS_DEPENDENCY_GRAPH_${DATE}.json`), JSON.stringify(dependencyGraph, null, 2));
writeFileSync(join(OUT, `OPERATIONAL_TASKS_ONBOARDING_INERTNESS_AUDIT_${DATE}.json`), JSON.stringify(inertnessAudit, null, 2));
writeFileSync(join(OUT, `OPERATIONAL_TASKS_LAYOUT_HUNK_MATRIX_${DATE}.json`), JSON.stringify(layoutHunkMatrix, null, 2));
writeFileSync(join(OUT, `OPERATIONAL_TASKS_LOTE1_TEST_RESULTS_V2_${DATE}.json`), JSON.stringify(testResults, null, 2));
writeFileSync(
  join(OUT, `OPERATIONAL_TASKS_LOTE1_BUILD_${DATE}.json`),
  JSON.stringify(
    {
      clean_branch_full_build: { pass: false, reason: "origin/main DevCenterToolbox broken pre-OT" },
      ot_module_compile_verification: { pass: true, method: "WIP full tree + Lote1 OT swap" },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(OUT, `OPERATIONAL_TASKS_LOTE1_CLEAN_BRANCH_DIFF_${DATE}.json`),
  JSON.stringify({ stat: diffStat, categories: { OPERATIONAL_TASKS: "operationalTasks/*", TESTS: testFiles } }, null, 2),
);
console.log("done");
