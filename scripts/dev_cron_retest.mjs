#!/usr/bin/env node
/**
 * Retest DEV cron workflows via gh — monitor runs, sanitize output.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const REPO = "ricardoas1301-code/suse7-backend";

function ghToken() {
  const cred = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const passMatch = /^password=(.+)$/m.exec(cred.stdout || "");
  if (!passMatch?.[1]) throw new Error("GitHub auth unavailable");
  return passMatch[1].trim();
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_TOKEN: ghToken() },
  }).trim();
}

function sanitizeLog(text) {
  return String(text || "")
    .replace(/ghs_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/X-Job-Secret:\s*\S+/gi, "X-Job-Secret: [REDACTED]")
    .replace(/JOB_SECRET=\S+/g, "JOB_SECRET=[REDACTED]");
}

function waitRun(workflowFile, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const out = gh(["run", "list", "--repo", REPO, "--workflow", workflowFile, "--limit", "1", "--json", "databaseId,status,conclusion,createdAt,headBranch,event,url,updatedAt"]);
    const run = JSON.parse(out)[0];
    if (run?.status === "completed") return run;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  throw new Error(`Timeout waiting for ${workflowFile}`);
}

function getRunDetails(runId) {
  const jobs = JSON.parse(gh(["run", "view", String(runId), "--repo", REPO, "--json", "jobs"]));
  const job = jobs.jobs?.[0];
  const annotations = [];
  if (job?.databaseId) {
    try {
      const ann = JSON.parse(
        execFileSync("curl.exe", ["-sS", `https://api.github.com/repos/${REPO}/check-runs/${job.databaseId}/annotations`], {
          encoding: "utf8",
        }),
      );
      for (const a of ann || []) {
        if (a.message) annotations.push(a.message);
      }
    } catch {
      /* optional */
    }
  }
  let logExcerpt = "";
  try {
    logExcerpt = sanitizeLog(gh(["run", "view", String(runId), "--repo", REPO, "--log"]));
  } catch {
    logExcerpt = "(log requires admin — using annotations)";
  }
  const httpMatches = [...logExcerpt.matchAll(/http_status=(\d{3})/g)].map((m) => Number(m[1]));
  const failedStep = job?.steps?.find((s) => s.conclusion === "failure")?.name || null;
  return {
    run_id: runId,
    job_name: job?.name,
    conclusion: job?.conclusion,
    failed_step: failedStep,
    http_statuses: httpMatches,
    annotations,
    log_excerpt_sanitized: logExcerpt.slice(-1500),
  };
}

function dispatchOrRerun(workflowFile, priorFailedRunId) {
  try {
    gh(["workflow", "run", workflowFile, "--repo", REPO]);
    return { mode: "workflow_dispatch", prior_run_id: priorFailedRunId };
  } catch {
    gh(["run", "rerun", String(priorFailedRunId), "--repo", REPO, "--failed"]);
    return { mode: "rerun_failed", prior_run_id: priorFailedRunId };
  }
}

async function main() {
  const target = process.argv[2];
  if (!target || !["billing-dev", "ml-webhook-dev"].includes(target)) {
    throw new Error("Usage: node dev_cron_retest.mjs billing-dev|ml-webhook-dev");
  }

  const map = {
    "billing-dev": {
      workflow_file: "billing-maintenance-cron-dev.yml",
      artifact: `BILLING_DEV_CRON_RETEST_${DATE}.json`,
      prior_run: 32107698690,
    },
    "ml-webhook-dev": {
      workflow_file: "ml-webhook-events-cron-dev.yml",
      artifact: `ML_WEBHOOK_DEV_CRON_RETEST_${DATE}.json`,
      prior_run: 32139849591,
    },
  };
  const cfg = map[target];

  const trigger = dispatchOrRerun(cfg.workflow_file, cfg.prior_run);
  const run = waitRun(cfg.workflow_file);
  const details = getRunDetails(run.databaseId);

  const result = {
    generated_at: new Date().toISOString(),
    workflow: cfg.workflow_file,
    trigger,
    run: {
      id: run.databaseId,
      url: run.url,
      conclusion: run.conclusion,
      event: run.event,
    },
    preflight: details.annotations.some((a) => a.includes("Missing")) ? "FAIL" : "PASS",
    http_statuses: details.http_statuses,
    failed_step: details.failed_step,
    result: run.conclusion === "success" ? "PASS" : "FAIL",
    classification:
      details.http_statuses.includes(401) || details.annotations.some((a) => /401|invalid.*secret/i.test(a))
        ? "JOB_SECRET_MISMATCH"
        : details.http_statuses.includes(403) || details.annotations.some((a) => /403|UNCONFIRMED/i.test(a))
          ? "BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED"
          : run.conclusion === "success"
            ? "CONFIGURATION_RECOVERED"
            : "OTHER",
    log_excerpt_sanitized: details.log_excerpt_sanitized,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, cfg.artifact), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.result === "PASS", result: result.result, classification: result.classification, http: result.http_statuses }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
