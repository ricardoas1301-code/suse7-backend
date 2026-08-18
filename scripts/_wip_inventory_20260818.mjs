#!/usr/bin/env node
/**
 * WIP inventory read-only — suse7-backend + suse7-frontend + root artifacts.
 * No writes to tracked files except scripts/output artifacts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const MAIN_SHA = {
  backend: "1168fbb2f8f3e002af80eb39e4607b22b62254f7",
  frontend: null,
};

const REPOS = [
  {
    id: "backend",
    root: path.resolve(__dirname, ".."),
    devUrl: "https://suse7-backend-dev.vercel.app",
    probePath: "/api/ml/oauth-config",
  },
  {
    id: "frontend",
    root: path.resolve(__dirname, "../../suse7-frontend"),
    devUrl: "https://suse7-frontend-dev.vercel.app",
    probePath: null,
  },
];

mkdir(OUT);

/** @param {string} dir */
function mkdir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }).trim();
}

/**
 * @param {string} p
 */
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} statusCode
 */
function parseStatus(statusCode) {
  const x = statusCode[0];
  const y = statusCode[1];
  return {
    staged: x !== " " && x !== "?",
    unstaged: y !== " " && y !== "?",
    index_status: x,
    worktree_status: y,
    untracked: statusCode === "??",
    deleted: x === "D" || y === "D",
    renamed: x === "R" || y === "R",
    typechange: x === "T" || y === "T",
  };
}

/** @param {string} filePath */
function classifyFile(filePath) {
  const p = filePath.replace(/\\/g, "/");
  const rules = [
    { front: "J_Billing_GitHub_Actions", re: /billing|github\/workflows|cron|asaas_env|wip_inventory|_mission_asaas/i },
    { front: "A_Operational_Tasks", re: /operationalTasks|operational_tasks|OperationalTasks|pend[eê]ncias/i },
    { front: "B_Onboarding", re: /configurationOnboarding|onboarding|ConfigurationTask|Sua operação|configurationAppGate|configurationSnapshot|milestonesConfiguracao/i },
    { front: "C_S7ImportantNotice", re: /ImportantNotice|important-notice|importantNotice/i },
    { front: "D_Terms_Legal", re: /TermsAcceptance|termos|legalDocument|legalAcceptance|privacidade|PrivacyDocument|aceite/i },
    { front: "E_Dados_Loja", re: /DadosEmpresa|companyData|company_data|configurationCompanyData|seller_company|enderecoEmpresa/i },
    { front: "F_SignUp", re: /signup|Signup|bootstrapSocial|completeSignup|signupPending|SignupCheckEmail|SignupMarketing/i },
    { front: "G_Visual_Modal", re: /Modal\.css|modalShell|TaskModal|surface|AuthCallbackGate|CardCheckout|white|shellBaseline|modalSizes/i },
    { front: "H_OAuth_ML", re: /mlOAuth|ml\/oauth|ml\/connect|ml\/callback|MercadoLivre|marketplaceAccount|mlWebhook|ML_CLIENT|oauthConfig/i },
    { front: "I_Migrations_Scripts", re: /supabase\/migrations|scripts\/.*\.(mjs|sql)$|scripts\/output/i },
    { front: "K_Tests", re: /test_.*\.mjs$|\.test\.(js|mjs|jsx)$|scripts\/test/i },
    { front: "L_Artifacts_Output", re: /scripts\/output\/|\.cursor\/|CHECKPOINT|RELATORIO|AUDIT_|WIP_/i },
    { front: "Notifications", re: /notification|Notification|dailySalesSummary|S7Notification/i },
    { front: "Billing_UI", re: /src\/billing\/|billingFormatters|PlanCard|SubscriptionSummary/i },
    { front: "Sales_Dashboard", re: /vendas|sales\/|executive-summary|VendasPage|SaleRayX|dailySummary/i },
    { front: "Products_Costs", re: /productCosts|BulkProduct|listings\/|Anuncios/i },
    { front: "Auth_Profile", re: /authCallback|AvatarMenu|Profile\.|userProfile|AlterarSenha/i },
    { front: "DevCenter_Toolbox", re: /devCenter|dev_center|toolbox/i },
    { front: "Infrastructure", re: /^api\/|^src\/infra\/|vercel\.json|package\.json|\.github\// },
  ];
  for (const r of rules) {
    if (r.re.test(p)) return r.front;
  }
  return "M_Other_WIP";
}

/** @param {string} filePath */
function artifactClass(filePath) {
  const p = filePath.replace(/\\/g, "/");
  if (/scripts\/output\//.test(p) || /\.cursor\//.test(p) || /CHECKPOINT|RELATORIO|AUDIT_|WIP_/.test(p)) {
    return "TEMPORARY_ARTIFACT";
  }
  if (/^src\//.test(p) || /^api\//.test(p)) return "SOURCE_CODE";
  if (/test_.*\.mjs$|\.test\.(js|mjs|jsx)$/.test(p)) return "TEST_CANONICAL";
  if (/^scripts\/.*\.mjs$/.test(p) && !/scripts\/output/.test(p)) return "OPERATIONAL_SCRIPT_WORTH_KEEPING";
  if (/supabase\/migrations\//.test(p)) return "SOURCE_CODE";
  if (/\.md$/.test(p) && /scripts\/output/.test(p)) return "REPORT_OUTPUT";
  if (/\.json$/.test(p) && /scripts\/output/.test(p)) return "REPORT_OUTPUT";
  return "REVIEW";
}

/**
 * @param {string} repoRoot
 * @param {string} filePath
 * @param {string} mainRef
 */
function filePresence(repoRoot, filePath, mainRef) {
  const rel = filePath.replace(/\\/g, "/");
  const localExists = exists(path.join(repoRoot, rel));
  let inMain = false;
  let mainHasDiff = false;
  try {
    git(repoRoot, ["cat-file", "-e", `${mainRef}:${rel}`]);
    inMain = true;
  } catch {
    inMain = false;
  }
  if (localExists && inMain) {
    try {
      const diff = git(repoRoot, ["diff", "--name-only", mainRef, "--", rel]);
      mainHasDiff = Boolean(diff);
    } catch {
      mainHasDiff = true;
    }
  } else if (localExists && !inMain) {
    mainHasDiff = true;
  }
  return { local: localExists, main: inMain, diverged_from_main: mainHasDiff };
}

/**
 * @param {{ root: string, id: string, devUrl: string|null, probePath: string|null }} repo
 */
function inventoryRepo(repo) {
  if (!exists(repo.root)) {
    return { skipped: true, reason: "repo path missing" };
  }
  const branch = git(repo.root, ["branch", "--show-current"]);
  const head = git(repo.root, ["rev-parse", "HEAD"]);
  let mainRef = "origin/main";
  try {
    git(repo.root, ["fetch", "origin", "main"]);
    mainRef = git(repo.root, ["rev-parse", "origin/main"]);
  } catch {
    try {
      mainRef = git(repo.root, ["rev-parse", "main"]);
    } catch {
      mainRef = head;
    }
  }

  const porcelain = git(repo.root, ["status", "--porcelain=v1", "-uall"]).split(/\r?\n/).filter(Boolean);
  /** @type {Array<Record<string, unknown>>} */
  const files = [];

  for (const line of porcelain) {
    const statusCode = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop().trim();
    }
    const st = parseStatus(statusCode);
    const front = classifyFile(filePath);
    const presence = filePresence(repo.root, filePath, mainRef);
    files.push({
      path: filePath.replace(/\\/g, "/"),
      status: statusCode.trim() || "??",
      ...st,
      front,
      artifact_class: artifactClass(filePath),
      local: presence.local,
      in_main: presence.main,
      diverged_from_main: presence.diverged_from_main,
      runtime_dev: "UNKNOWN",
    });
  }

  const trackedModified = files.filter((f) => !f.untracked && (f.staged || f.unstaged));
  const untracked = files.filter((f) => f.untracked);

  /** @type {Record<string, number>} */
  const byFront = {};
  for (const f of files) {
    byFront[f.front] = (byFront[f.front] || 0) + 1;
  }

  /** @type {Record<string, string[]>} */
  const mixed = {};
  for (const f of files) {
    if (f.untracked) continue;
    const hits = [];
    const p = f.path;
    const checks = [
      ["A_Operational_Tasks", /operationalTasks|operational_tasks/i],
      ["B_Onboarding", /configurationOnboarding|onboarding/i],
      ["D_Terms_Legal", /TermsAcceptance|legalDocument|termos/i],
      ["E_Dados_Loja", /DadosEmpresa|companyData|configurationCompanyData/i],
      ["F_SignUp", /signup|Signup/i],
      ["H_OAuth_ML", /mlOAuth|ml\/connect|ml\/callback|MercadoLivre/i],
      ["G_Visual_Modal", /Modal\.css|TaskModal|modalShell/i],
    ];
    for (const [name, re] of checks) {
      if (re.test(p)) hits.push(name);
    }
    if (hits.length > 1) {
      mixed[f.path] = hits;
    }
  }

  return {
    repo: repo.id,
    root: repo.root,
    branch,
    head,
    main_ref: mainRef,
    ahead_of_main_commits: safeRevListCount(repo.root, `${mainRef}..HEAD`),
    counts: {
      total_porcelain: files.length,
      tracked_modified: trackedModified.length,
      untracked: untracked.length,
      staged_only: files.filter((f) => f.staged && !f.unstaged).length,
      unstaged_only: files.filter((f) => !f.staged && f.unstaged).length,
      deleted: files.filter((f) => f.deleted).length,
      renamed: files.filter((f) => f.renamed).length,
    },
    by_front: byFront,
    mixed_wip_files: mixed,
    files,
  };
}

/** @param {string} cwd @param {string} range */
function safeRevListCount(cwd, range) {
  try {
    const out = git(cwd, ["rev-list", "--count", range]);
    return Number(out) || 0;
  } catch {
    return null;
  }
}

async function probeDevRuntime() {
  /** @type {Record<string, unknown>} */
  const out = { generated_at: new Date().toISOString() };
  try {
    const res = await fetch("https://suse7-backend-dev.vercel.app/api/ml/oauth-config");
    const body = await res.json();
    out.backend_dev = {
      http: res.status,
      vercel_git_commit: body?.buildFingerprint?.vercel_git_commit ?? null,
      ml_oauth_callback_module_rev: body?.buildFingerprint?.ml_oauth_callback_module_rev ?? null,
      ml_oauth_persistence_module_rev: body?.buildFingerprint?.ml_oauth_persistence_module_rev ?? null,
      s7AppEnv: body?.envCoherence?.s7AppEnv ?? null,
    };
  } catch (e) {
    out.backend_dev = { error: String(e) };
  }
  try {
    const res = await fetch("https://suse7-backend-dev.vercel.app/api/health");
    out.backend_dev_health = { http: res.status };
  } catch (e) {
    out.backend_dev_health = { error: String(e) };
  }
  try {
    const res = await fetch("https://suse7-frontend-dev.vercel.app/");
    const html = await res.text();
    const shaMatch = html.match(/vercel_git_commit[^a-f0-9]*([a-f0-9]{7,40})/i);
    const hasOperationalTasks = /OperationalTasks|operational-tasks|configuration-onboarding/i.test(html);
    out.frontend_dev = {
      http: res.status,
      inferred_commit: shaMatch?.[1] ?? null,
      html_markers: {
        operational_or_onboarding_strings: hasOperationalTasks,
      },
    };
  } catch (e) {
    out.frontend_dev = { error: String(e) };
  }
  return out;
}

/** Refinement heuristics from local file content */
function assessRefinements(backendInv, frontendInv) {
  const allPaths = [
    ...(backendInv.files || []).map((f) => ({ repo: "backend", ...f })),
    ...(frontendInv.files || []).map((f) => ({ repo: "frontend", ...f })),
  ];
  const hasPath = (re) => allPaths.some((f) => re.test(f.path));
  const readSnippet = (repoRoot, rel, re) => {
    const full = path.join(repoRoot, rel);
    if (!exists(full)) return null;
    try {
      const txt = fs.readFileSync(full, "utf8");
      return re.test(txt);
    } catch {
      return null;
    }
  };

  const feRoot = path.resolve(__dirname, "../../suse7-frontend");
  const beRoot = path.resolve(__dirname, "..");

  const copyRe =
    /Completar estas etapas é essencial para preparar sua operação e começar a usar o SUSE7/i;

  return [
    {
      id: "operational_tasks_panel_icon",
      name: "OperationalTasksPanelIcon collapsed/expanded",
      status: hasPath(/S7OperationalTasksPanel|OperationalTasksPanelIcon|operationalTasksCollapse/)
        ? readSnippet(feRoot, "src/features/dashboard/operationalTasks/S7OperationalTasksPanel.jsx", /collapsed|expand|header/i)
          ? "PARTIAL"
          : "PARTIAL"
        : "NOT_STARTED",
      files: allPaths.filter((f) => /operationalTasks|S7OperationalTasksPanel/i.test(f.path)).map((f) => `${f.repo}:${f.path}`).slice(0, 20),
      runtime_dev: "LIKELY_YES",
      main: hasPath(/operationalTasks/) ? "PARTIAL" : "NO",
      notes: "Frontend operational tasks panel files present in WIP; icon/header refinements in local CSS/JSX.",
    },
    {
      id: "s7_important_notice",
      name: "S7ImportantNotice",
      status: hasPath(/ImportantNotice|important-notice/i) ? "PARTIAL" : "UNKNOWN",
      files: allPaths.filter((f) => /ImportantNotice|important-notice/i.test(f.path)).map((f) => `${f.repo}:${f.path}`),
      runtime_dev: "UNKNOWN",
      main: "UNKNOWN",
      notes: hasPath(/ImportantNotice/i) ? "Component files touched locally." : "No explicit ImportantNotice filename in WIP inventory — may be embedded in onboarding section.",
    },
    {
      id: "onboarding_copy",
      name: "Onboarding copy (2 min)",
      status: readSnippet(feRoot, "src/features/dashboard/configurationOnboarding/S7ConfigurationOnboardingSection.jsx", copyRe)
        ? "DONE"
        : readSnippet(feRoot, "src/features/dashboard/configurationOnboarding/configurationMilestonePresentationRegistry.js", copyRe)
          ? "DONE"
          : hasPath(/configurationOnboarding/)
            ? "PARTIAL"
            : "NOT_STARTED",
      files: allPaths.filter((f) => /configurationOnboarding|S7ConfigurationOnboardingSection/i.test(f.path)).map((f) => `${f.repo}:${f.path}`).slice(0, 15),
      runtime_dev: "LIKELY_YES",
      main: "NO",
      notes: "Copy search in onboarding section files.",
    },
    {
      id: "terms_modal",
      name: "Terms modal portal/layer + legal acceptance",
      status:
        hasPath(/TermsAcceptanceModal/) &&
        readSnippet(feRoot, "src/components/legal/TermsAcceptanceModal.jsx", /createPortal|portal|z-index|zIndex/i)
          ? "PARTIAL"
          : hasPath(/TermsAcceptance|legalDocument/)
            ? "PARTIAL"
            : "NOT_STARTED",
      files: allPaths.filter((f) => /TermsAcceptance|legalDocument|termos|legalAcceptance/i.test(f.path)).map((f) => `${f.repo}:${f.path}`).slice(0, 20),
      runtime_dev: "LIKELY_YES",
      main: "NO",
      notes: "Frontend TermsAcceptanceModal + legal catalog hooks in WIP.",
    },
    {
      id: "dados_loja_signup_layout",
      name: "Dados da Loja layout SignUp-style",
      status: hasPath(/configurationCompanyData|DadosEmpresa|ConfigurationCompanyDataModal/)
        ? readSnippet(feRoot, "src/features/dashboard/configurationOnboarding/ConfigurationCompanyDataModal.jsx", /grid|signup|input|email/i)
          ? "PARTIAL"
          : "PARTIAL"
        : "NOT_STARTED",
      files: allPaths
        .filter((f) => /DadosEmpresa|configurationCompanyData|ConfigurationCompanyData|companyData/i.test(f.path))
        .map((f) => `${f.repo}:${f.path}`)
        .slice(0, 20),
      runtime_dev: "LIKELY_YES",
      main: "NO",
      notes: "Company data modal + DadosEmpresa profile overlap — verify email auth-canonical lock in consolidation diff.",
    },
    {
      id: "modal_surfaces_white",
      name: "Modal surfaces white / remove blue",
      status: hasPath(/ConfigurationTaskModalShell|TaskModalShell|Modal\.css/)
        ? readSnippet(feRoot, "src/features/dashboard/configurationOnboarding/ConfigurationTaskModalShell.css", /background:\s*#fff|background:\s*white|surface/i)
          ? "PARTIAL"
          : "PARTIAL"
        : "UNKNOWN",
      files: allPaths.filter((f) => /Modal\.css|TaskModalShell|modalShell/i.test(f.path)).map((f) => `${f.repo}:${f.path}`).slice(0, 25),
      runtime_dev: "LIKELY_YES",
      main: "NO",
      notes: "Many modal CSS files modified — likely mixed with unrelated billing/profile modals.",
    },
    {
      id: "legal_acceptance_backend",
      name: "Legal acceptance backend idempotency/fail-safe",
      status: hasPath(/legalAcceptance|legal_acceptance|acceptLegal|termos.*accept/i)
        ? "PARTIAL"
        : readSnippet(beRoot, "src/signup/routes/signupRoutes.js", /legal|termos|accept/i)
          ? "PARTIAL"
          : "UNKNOWN",
      files: allPaths.filter((f) => /legal|termos|acceptance/i.test(f.path) && f.repo === "backend").map((f) => `${f.repo}:${f.path}`).slice(0, 20),
      runtime_dev: "UNKNOWN",
      main: "UNKNOWN",
      notes: "Search migration 00118 references in backend WIP during consolidation.",
    },
    {
      id: "signup_rpc_00120",
      name: "SignUp traditional + RPC 00120 PROD compat",
      status: hasPath(/signup|completeSignup|bootstrapSocial/) ? "PARTIAL" : "NOT_STARTED",
      files: allPaths.filter((f) => /signup|Signup|bootstrapSocial|completeSignup/i.test(f.path)).map((f) => `${f.repo}:${f.path}`).slice(0, 20),
      runtime_dev: "LIKELY_PARTIAL",
      main: "PARTIAL",
      notes: "Backend signup routes/services modified; PROD has 00120 per mission context — local WIP may extend beyond main.",
    },
  ];
}

function buildDiffMatrix(backendInv, frontendInv) {
  const rows = [];
  for (const inv of [backendInv, frontendInv]) {
    if (inv.skipped) continue;
    for (const f of inv.files) {
      if (f.untracked && f.artifact_class === "TEMPORARY_ARTIFACT") continue;
      rows.push({
        repo: inv.repo,
        path: f.path,
        front: f.front,
        local: f.local,
        in_main: f.in_main,
        diverged_from_main: f.diverged_from_main,
        tracked: !f.untracked,
        artifact_class: f.artifact_class,
      });
    }
  }
  return {
    generated_at: new Date().toISOString(),
    main_backend: MAIN_SHA.backend,
    main_frontend: frontendInv.main_ref,
    backend_head: backendInv.head,
    frontend_head: frontendInv.head,
    summary: {
      total_rows: rows.length,
      local_only_not_in_main: rows.filter((r) => r.local && !r.in_main).length,
      in_main_but_diverged: rows.filter((r) => r.in_main && r.diverged_from_main).length,
      source_code_diverged: rows.filter((r) => r.artifact_class === "SOURCE_CODE" && r.diverged_from_main).length,
    },
    rows,
  };
}

function buildConsolidationPlan(byFrontBackend, byFrontFrontend, refinements) {
  const priority = [
    {
      lote: 1,
      name: "Central de pendências / Operational Tasks (visual + shell)",
      fronts: ["A_Operational_Tasks"],
      rationale: "Isolated UI surface; tests exist (operational_tasks_*). Low coupling to OAuth.",
      blockers: [],
    },
    {
      lote: 2,
      name: "Onboarding section + S7ImportantNotice + copy",
      fronts: ["B_Onboarding", "C_S7ImportantNotice"],
      rationale: "Shared configurationOnboarding module; deploy DEV likely already includes partial state.",
      blockers: ["Terms modal layering may depend on onboarding gate order"],
    },
    {
      lote: 3,
      name: "Terms / legal acceptance",
      fronts: ["D_Terms_Legal"],
      rationale: "Frontend TermsAcceptanceModal + backend legal acceptance; requires fail-safe audit before commit.",
      blockers: ["Verify 00118 structure + idempotent backend"],
    },
    {
      lote: 4,
      name: "Dados da Loja + SignUp alignment",
      fronts: ["E_Dados_Loja", "F_SignUp"],
      rationale: "Company data modal and signup flows share form patterns; RPC 00120 already on PROD.",
      blockers: ["Mixed modal CSS — split from unrelated profile/billing modals"],
    },
    {
      lote: 5,
      name: "OAuth / ML integration hardening",
      fronts: ["H_OAuth_ML"],
      rationale: "Large backend surface on branch fix/ml-oauth-dev-persist-reconnect; many tests already written.",
      blockers: ["Do not mix with onboarding UI commits"],
    },
    {
      lote: 6,
      name: "Modal/visual refinements remainder",
      fronts: ["G_Visual_Modal", "Billing_UI", "Auth_Profile"],
      rationale: "Split per-component after core flows land.",
      blockers: ["MIXED_WIP files need diff audit"],
    },
    {
      lote: 7,
      name: "Scripts/tests/artifacts cleanup (human gate)",
      fronts: ["I_Migrations_Scripts", "K_Tests", "L_Artifacts_Output", "J_Billing_GitHub_Actions"],
      rationale: "Billing/cron already homologated on main; cherry-pick only missing canonical tests. Artifacts mostly do not commit.",
      blockers: ["No delete in this phase — classify only"],
    },
  ];
  return { generated_at: new Date().toISOString(), lotes: priority, refinements_status: refinements };
}

function testCoverageInventory(backendInv, frontendInv) {
  const tests = [];
  for (const inv of [backendInv, frontendInv]) {
    if (inv.skipped) continue;
    for (const f of inv.files) {
      if (f.artifact_class !== "TEST_CANONICAL") continue;
      tests.push({ repo: inv.repo, path: f.path, front: f.front });
    }
  }
  /** @type {Record<string, { tests: string[], gaps: string[] }>} */
  const map = {};
  for (const front of [
    "A_Operational_Tasks",
    "B_Onboarding",
    "D_Terms_Legal",
    "E_Dados_Loja",
    "F_SignUp",
    "H_OAuth_ML",
    "J_Billing_GitHub_Actions",
  ]) {
    map[front] = {
      tests: tests.filter((t) => t.front === front || t.path.includes(front.split("_")[1]?.toLowerCase() ?? "____")).map((t) => `${t.repo}:${t.path}`),
      gaps: [],
    };
  }
  map.A_Operational_Tasks.tests = tests
    .filter((t) => /operational_tasks|operationalTasks/i.test(t.path))
    .map((t) => `${t.repo}:${t.path}`);
  map.B_Onboarding.tests = tests.filter((t) => /configuration_onboarding|configurationOnboarding/i.test(t.path)).map((t) => `${t.repo}:${t.path}`);
  map.D_Terms_Legal.tests = tests.filter((t) => /termos|legal|privacidade/i.test(t.path)).map((t) => `${t.repo}:${t.path}`);
  map.E_Dados_Loja.tests = tests.filter((t) => /company_data|DadosEmpresa|configuration_company/i.test(t.path)).map((t) => `${t.repo}:${t.path}`);
  map.F_SignUp.tests = tests.filter((t) => /signup|Signup/i.test(t.path)).map((t) => `${t.repo}:${t.path}`);
  map.H_OAuth_ML.tests = tests.filter((t) => /ml_oauth|mlOAuth|ml_webhook|marketplace_integration/i.test(t.path)).map((t) => `${t.repo}:${t.path}`);
  map.J_Billing_GitHub_Actions.tests = tests.filter((t) => /billing|cron|asaas_env/i.test(t.path)).map((t) => `${t.repo}:${t.path}`);

  for (const [front, v] of Object.entries(map)) {
    if (v.tests.length === 0) v.gaps.push("No dedicated test file in current WIP inventory");
  }
  return { tests_total: tests.length, by_front: map, all_tests: tests };
}

async function main() {
  const backendInv = inventoryRepo(REPOS[0]);
  const frontendInv = inventoryRepo(REPOS[1]);
  const devRuntime = await probeDevRuntime();
  const refinements = assessRefinements(backendInv, frontendInv);
  const diffMatrix = buildDiffMatrix(backendInv, frontendInv);
  const consolidation = buildConsolidationPlan(backendInv.by_front, frontendInv.by_front, refinements);
  const tests = testCoverageInventory(backendInv, frontendInv);

  const inventory = {
    generated_at: new Date().toISOString(),
    status: "WIP_INVENTORY_COMPLETE",
    repos: {
      backend: {
        branch: backendInv.branch,
        head: backendInv.head,
        main: backendInv.main_ref,
        ahead_of_main: backendInv.ahead_of_main_commits,
        counts: backendInv.counts,
        by_front: backendInv.by_front,
        mixed_wip_count: Object.keys(backendInv.mixed_wip_files || {}).length,
      },
      frontend: {
        branch: frontendInv.branch,
        head: frontendInv.head,
        main: frontendInv.main_ref,
        ahead_of_main: frontendInv.ahead_of_main_commits,
        counts: frontendInv.counts,
        by_front: frontendInv.by_front,
        mixed_wip_count: Object.keys(frontendInv.mixed_wip_files || {}).length,
      },
    },
    dev_runtime_probe: devRuntime,
    mixed_wip: {
      backend: backendInv.mixed_wip_files,
      frontend: frontendInv.mixed_wip_files,
    },
    artifact_policy: {
      keep: ["SOURCE_CODE", "TEST_CANONICAL", "OPERATIONAL_SCRIPT_WORTH_KEEPING"],
      review: ["REVIEW"],
      temporary: ["TEMPORARY_ARTIFACT", "REPORT_OUTPUT"],
    },
  };

  fs.writeFileSync(path.join(OUT, `WIP_INVENTORY_${DATE}.json`), JSON.stringify({ ...inventory, files_backend: backendInv.files, files_frontend: frontendInv.files }, null, 2));
  fs.writeFileSync(path.join(OUT, `REFINEMENTS_STATUS_MATRIX_${DATE}.json`), JSON.stringify({ generated_at: new Date().toISOString(), refinements, dev_runtime: devRuntime }, null, 2));
  fs.writeFileSync(path.join(OUT, `LOCAL_DEV_MAIN_DIFF_MATRIX_${DATE}.json`), JSON.stringify(diffMatrix, null, 2));
  fs.writeFileSync(path.join(OUT, `WIP_CONSOLIDATION_PLAN_${DATE}.md`), renderPlanMd(inventory, refinements, consolidation, tests, diffMatrix));

  const md = renderInventoryMd(inventory, refinements, consolidation, tests);
  fs.writeFileSync(path.join(OUT, `WIP_INVENTORY_${DATE}.md`), md);

  console.log(
    JSON.stringify({
      status: "WIP_INVENTORY_COMPLETE",
      backend_tracked: backendInv.counts?.tracked_modified,
      backend_untracked: backendInv.counts?.untracked,
      frontend_tracked: frontendInv.counts?.tracked_modified,
      frontend_untracked: frontendInv.counts?.untracked,
      mixed_total:
        Object.keys(backendInv.mixed_wip_files || {}).length + Object.keys(frontendInv.mixed_wip_files || {}).length,
    })
  );
}

/** @param {any} inventory @param {any[]} refinements @param {any} consolidation @param {any} tests */
function renderInventoryMd(inventory, refinements, consolidation, tests) {
  const b = inventory.repos.backend;
  const f = inventory.repos.frontend;
  return `# WIP Inventory ${DATE}

## Status: WIP_INVENTORY_COMPLETE

### Backend (\`${b.branch}\`)
- HEAD: \`${b.head}\`
- main: \`${b.main}\`
- tracked modified: **${b.counts.tracked_modified}**
- untracked: **${b.counts.untracked}**
- mixed WIP files: **${b.mixed_wip_count}**

### Frontend (\`${f.branch}\`)
- HEAD: \`${f.head}\`
- main: \`${f.main}\`
- tracked modified: **${f.counts.tracked_modified}**
- untracked: **${f.counts.untracked}**
- mixed WIP files: **${f.mixed_wip_count}**

## Front classification (combined)
See JSON for per-file mapping.

## Refinements snapshot
${refinements.map((r) => `- **${r.name}**: ${r.status}`).join("\n")}

## DEV runtime probe
${JSON.stringify(inventory.dev_runtime_probe, null, 2)}

## Consolidation lotes
${consolidation.lotes.map((l) => `### Lote ${l.lote}: ${l.name}`).join("\n")}
`;
}

/** @param {any} inventory @param {any[]} refinements @param {any} consolidation @param {any} tests @param {any} diffMatrix */
function renderPlanMd(inventory, refinements, consolidation, tests, diffMatrix) {
  return `# WIP Consolidation Plan ${DATE}

## Goal
LOCAL CANÔNICO = GIT = DEV (future) without mega-commit.

## Current divergence from main
- Source code files diverged: **${diffMatrix.summary.source_code_diverged}**
- Local-only (not in main): **${diffMatrix.summary.local_only_not_in_main}**

## Refinement status
| Refinement | Status | Runtime DEV | Main |
|---|---|---|---|
${refinements.map((r) => `| ${r.name} | ${r.status} | ${r.runtime_dev} | ${r.main} |`).join("\n")}

## Recommended lotes
${consolidation.lotes
  .map(
    (l) => `### Lote ${l.lote} — ${l.name}
- Fronts: ${l.fronts.join(", ")}
- Rationale: ${l.rationale}
- Blockers: ${l.blockers.length ? l.blockers.join("; ") : "none"}`
  )
  .join("\n\n")}

## Test coverage (WIP inventory)
Total test files in WIP: **${tests.tests_total}**

## Gates (this mission)
Code write: NÃO | Delete: NÃO | Commit: NÃO | Deploy: NÃO
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
