#!/usr/bin/env node
/** P0.3-C.1B-R — local HTTP handler test (H1/H2). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

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

const envFile = parseEnvFile(path.join(root, ".env.local"));
process.env.SUPABASE_URL = process.env.SUPABASE_URL || envFile.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || envFile.SUPABASE_SERVICE_ROLE_KEY;
process.env.JOB_SECRET = process.env.JOB_SECRET || envFile.JOB_SECRET;

function createMockReqRes({ headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = headers;
  req.query = {};

  /** @type {{ statusCode: number; body: unknown; headers: Record<string, string> }} */
  const state = { statusCode: 0, body: null, headers: {} };
  const res = {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    setHeader(k, v) {
      state.headers[k] = v;
    },
    end(payload) {
      state.body = payload;
    },
  };

  return { req, res, state };
}

const handler = (await import("../src/handlers/jobs/billingBillableSaleAdmissionReconcilerJob.js")).default;

/** @type {Array<{ name: string; status: number; body: unknown }>} */
const results = [];

{
  const { req, res, state } = createMockReqRes({
    headers: { "x-job-secret": process.env.JOB_SECRET },
  });
  await handler(req, res);
  results.push({ name: "H1_success_real_job", status: state.statusCode, body: state.body });
  assert.equal(state.statusCode, 200);
  assert.equal(state.body?.ok, true);
  assert.ok(state.body?.traceId);
  assert.ok(state.body?.result?.budget != null || state.body?.result?.phase_timings_ms != null);
}

{
  const { req, res, state } = createMockReqRes({ headers: { "x-job-secret": "wrong" } });
  await handler(req, res);
  results.push({ name: "H2_auth_fail", status: state.statusCode, body: state.body });
  assert.equal(state.statusCode, 401);
  assert.equal(state.body?.code, "UNAUTHORIZED");
}

const handlerSrc = fs.readFileSync(
  path.join(root, "src/handlers/jobs/billingBillableSaleAdmissionReconcilerJob.js"),
  "utf8",
);
assert.ok(handlerSrc.includes('code: "RECONCILER_FAILED"'));
results.push({
  name: "H2_exception_contract_static",
  status: 200,
  body: { code: "RECONCILER_FAILED", static: true },
});

const out = {
  ok: true,
  results: results.map((r) => ({
    name: r.name,
    status: r.status,
    code: r.body?.code ?? null,
    ok: r.body?.ok ?? null,
    has_traceId: Boolean(r.body?.traceId),
    elapsed_ms: r.body?.result?.budget?.elapsed_ms ?? null,
    soft_yield: r.body?.result?.soft_yield ?? null,
  })),
  generated_at: new Date().toISOString(),
};

const outPath = path.join(root, "scripts/output/P0_3C1B_R_LOCAL_HTTP.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
