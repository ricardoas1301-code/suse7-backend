#!/usr/bin/env node
/**
 * P0.2-N.2 — subprocess: env limpo garante import fresco de config/handler.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const localEnv = parseEnvFile(path.join(root, ".env.local"));
const jobSecret = localEnv.JOB_SECRET || localEnv.DEV_JOB_SECRET || process.env.JOB_SECRET || "";

const childEnv = { ...process.env, JOB_SECRET: jobSecret };
delete childEnv.SUPABASE_URL;
delete childEnv.SUPABASE_SERVICE_ROLE_KEY;

const inline = `
import { handleJobsMarketplaceAccountSync } from "./src/handlers/jobs/marketplaceAccountSyncJob.js";
const req = { method: "POST", query: { limit: "1" }, headers: { "x-job-secret": ${JSON.stringify(jobSecret)} }, body: { limit: 1 } };
const out = await new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c){ this.statusCode=c; return this; }, json(o){ resolve({ status: this.statusCode ?? 200, body: o }); } };
  handleJobsMarketplaceAccountSync(req, res).catch(reject);
});
console.log("__RESULT__:" + JSON.stringify(out));
`;

const r = spawnSync(process.execPath, ["--input-type=module", "-e", inline], {
  cwd: root,
  env: childEnv,
  encoding: "utf8",
});

if (r.status !== 0) {
  console.error(JSON.stringify({ ok: false, stderr: r.stderr, stdout: r.stdout }, null, 2));
  process.exit(1);
}

const line = String(r.stdout || "")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.startsWith("__RESULT__:"))
  .pop();
if (!line) {
  console.error(JSON.stringify({ ok: false, reason: "missing_result_line", stdout: r.stdout?.slice(-500) }, null, 2));
  process.exit(1);
}
const parsed = JSON.parse(line.slice("__RESULT__:".length));
if (parsed.status !== 503) {
  console.error(JSON.stringify({ ok: false, reason: "expected_503", got: parsed }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, test: "handler_supabase_config_guard", status: parsed.status }, null, 2));
