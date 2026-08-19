#!/usr/bin/env node
/**
 * Gate CORS — allowlist por ambiente (unit, sem rede).
 */

import { applyCors } from "../src/middlewares/cors.js";

const failures = [];
let passed = 0;

function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

function mockRes() {
  /** @type {Record<string, string>} */
  const headers = {};
  return {
    statusCode: 200,
    setHeader(k, v) {
      headers[k.toLowerCase()] = String(v);
    },
    end() {},
    headers,
  };
}

function runApplyCors(method, origin, extraEnv = {}) {
  const prev = { ...process.env };
  Object.assign(process.env, extraEnv);
  const req = { method, headers: origin ? { origin } : {} };
  const res = mockRes();
  const finished = applyCors(req, res);
  for (const k of Object.keys(prev)) process.env[k] = prev[k];
  return { finished, headers: res.headers, statusCode: res.statusCode };
}

const prodOrigin = "https://suse7.com.br";
const devOrigin = "https://suse7-frontend-dev.vercel.app";
const localOrigin = "http://localhost:5173";
const evilOrigin = "https://evil.example";

// Simula PROD: apenas origins canônicas via env explícito (sem DEV)
{
  const env = { CORS_ALLOWED_ORIGINS: `${prodOrigin},https://www.suse7.com.br` };
  const optProd = runApplyCors("OPTIONS", prodOrigin, env);
  assert("PROD OPTIONS prod ACAO", optProd.headers["access-control-allow-origin"] === prodOrigin);
  const optDev = runApplyCors("OPTIONS", devOrigin, env);
  assert("PROD OPTIONS dev blocked", !optDev.headers["access-control-allow-origin"]);
  const postEvil = runApplyCors("POST", evilOrigin, env);
  assert("PROD POST evil blocked", !postEvil.headers["access-control-allow-origin"]);
}

// Simula DEV: env inclui frontend DEV + localhost
{
  const env = { CORS_ALLOWED_ORIGINS: `${devOrigin},${localOrigin}` };
  const optDev = runApplyCors("OPTIONS", devOrigin, env);
  assert("DEV OPTIONS dev ACAO", optDev.headers["access-control-allow-origin"] === devOrigin);
  const optLocal = runApplyCors("OPTIONS", localOrigin, env);
  assert("DEV OPTIONS local ACAO", optLocal.headers["access-control-allow-origin"] === localOrigin);
}

console.log(`test_cors_env_gate_unit: ${passed} passed${failures.length ? `, FAIL: ${failures.join("; ")}` : ""}`);
if (failures.length) process.exit(1);
