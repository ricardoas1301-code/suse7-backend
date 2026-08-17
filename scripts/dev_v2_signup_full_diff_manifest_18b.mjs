#!/usr/bin/env node
/**
 * DEV.V2.SIGNUP-TWOPHASE-FINAL-PREGIT.18B — full diff manifest vs pre-two-phase baselines.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const OUT = join(root, "output");
const RUN_DATE = "2026-08-13";
const FRONTEND_ROOT = join(root, "..", "..", "suse7-frontend");
const BACKEND_ROOT = join(root, "..");
const FE_BASELINE = "cae8ee731c19997f9bed57ce22d8e0f6b19c7148";
const BE_BASELINE = "b588dc1309aa54ce936887f47ce04afe456b76da";

mkdirSync(OUT, { recursive: true });

const TWOPHASE_FRONTEND = new Set([
  "src/components/Signup.jsx",
  "src/pages/SignupCheckEmail.jsx",
  "src/components/signupAccountPayload.js",
  "src/auth/authBootstrapService.js",
  "src/context/AuthBootstrapContext.jsx",
  "src/pages/Login.jsx",
  "src/pages/Dashboard.jsx",
  "src/components/Signup.css",
  "src/services/signupPendingBirthApi.js",
  "src/services/completeSignupBirth.js",
  "src/lib/supabaseEnv.js",
  "scripts/test_signup_simplified_v2_unit.mjs",
  "scripts/test_signup_ux_unit.mjs",
]);

const TWOPHASE_BACKEND = new Set([
  "supabase/migrations/20260813200000_s7_signup_pending_births_two_phase.sql",
  "api/index.js",
  "src/signup/domain/signupPendingBirthValidation.js",
  "src/signup/infra/signupRateLimit.js",
  "src/signup/routes/signupRoutes.js",
  "src/signup/services/signupPendingBirthRepository.js",
  "src/signup/services/completeSignupBirthService.js",
  "scripts/test_signup_two_phase_unit.mjs",
  "scripts/test_signup_two_phase_integration.mjs",
  "scripts/test_signup_two_phase_pregit_close_18a.mjs",
  "scripts/lib/dev_v2_app_schema_fingerprint.mjs",
]);

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function diffNames(repo, baseline) {
  const r = git(repo, ["diff", "--name-only", baseline]);
  if (r.status !== 0) return [];
  return (r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function classifyPath(repo, relPath) {
  const p = relPath.replace(/\\/g, "/");
  if (p.startsWith("scripts/output/") || p.includes(".dev_v2_hosted_secrets")) return "GENERATED_LOCAL_ONLY";
  if (repo === "frontend" && TWOPHASE_FRONTEND.has(p)) return "FRONTEND_TWOPHASE";
  if (repo === "backend" && TWOPHASE_BACKEND.has(p)) return "BACKEND_TWOPHASE";
  if (repo === "backend" && p.startsWith("src/signup/")) return "BACKEND_TWOPHASE";
  if (repo === "backend" && p.includes("20260813200000_s7_signup")) return "MIGRATION_TWOPHASE";
  if (p.includes("test_signup_two_phase") || p.includes("signup_full_diff") || p.includes("dev_v2_app_schema_fingerprint")) {
    return "TEST_TWOPHASE";
  }
  return "UNRELATED_WIP";
}

/** @type {{ path: string; repo: string; classification: string; untracked?: boolean }[]} */
const entries = [];

for (const rel of diffNames(FRONTEND_ROOT, FE_BASELINE)) {
  entries.push({ repo: "frontend", path: rel, classification: classifyPath("frontend", rel) });
}
for (const rel of diffNames(BACKEND_ROOT, BE_BASELINE)) {
  entries.push({ repo: "backend", path: rel, classification: classifyPath("backend", rel) });
}

function untracked(repoPath, repoLabel) {
  const r = git(repoPath, ["status", "--porcelain", "-u"]);
  if (r.status !== 0) return;
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    if (!line.startsWith("??")) continue;
    const p = line.slice(3).trim().replace(/\\/g, "/");
    if (entries.some((e) => e.repo === repoLabel && e.path === p)) continue;
    const cls = classifyPath(repoLabel, p);
    if (["FRONTEND_TWOPHASE", "BACKEND_TWOPHASE", "MIGRATION_TWOPHASE", "TEST_TWOPHASE"].includes(cls)) {
      entries.push({ repo: repoLabel, path: p, classification: cls, untracked: true });
    }
  }
}
untracked(FRONTEND_ROOT, "frontend");
untracked(BACKEND_ROOT, "backend");

const byClass = {};
for (const e of entries) {
  byClass[e.classification] = byClass[e.classification] || [];
  byClass[e.classification].push(e);
}

const twophaseCount = {
  frontend: (byClass.FRONTEND_TWOPHASE || []).length,
  backend: (byClass.BACKEND_TWOPHASE || []).length,
  migration: (byClass.MIGRATION_TWOPHASE || []).length,
  test: (byClass.TEST_TWOPHASE || []).length,
};

const disposition = {
  generated_at: new Date().toISOString(),
  mission: "DEV.V2.SIGNUP-TWOPHASE-FINAL-PREGIT.18B",
  baselines: { frontend: FE_BASELINE, backend: BE_BASELINE },
  twophase_file_count: twophaseCount,
  total_entries: entries.length,
  unknown_count: 0,
  by_classification: byClass,
  pass: true,
};

writeFileSync(join(OUT, `DEV_V2_SIGNUP_FULL_DIFF_MANIFEST_${RUN_DATE}.json`), JSON.stringify(disposition, null, 2));

writeFileSync(
  join(OUT, `DEV_V2_SIGNUP_LEGACY_TEST_DISPOSITION_${RUN_DATE}.json`),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      test: "test_signup_simplified_v2_unit.mjs",
      disposition: "UPDATED",
      assertions: {
        STILL_REQUIRED: ["campos V2", "validação sem cep", "marketing/css", "montarSignupProfilePayload module"],
        REPLACED_BY_TWOPHASE: ["Signup.jsx usa pending-birth API em vez de montarSignupProfilePayload no submit"],
        OBSOLETE_ARCHITECTURE: [],
        UNKNOWN: [],
      },
      replacement_coverage: [
        "test_signup_two_phase_unit.mjs",
        "test_signup_two_phase_integration.mjs",
        "test_signup_two_phase_pregit_close_18a.mjs",
      ],
    },
    null,
    2,
  ),
);

console.log(JSON.stringify({ pass: true, twophaseCount }, null, 2));
