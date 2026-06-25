#!/usr/bin/env node
/**
 * BILLING 04.16 — autenticação dos jobs de billing (X-Job-Secret).
 * Uso:
 *   S7_BILLING_DEV_BASE_URL=https://... JOB_SECRET=... node scripts/validateBillingJobRoutesAuth.mjs
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const jobSecret = process.env.JOB_SECRET?.trim() || process.env.DEV_JOB_SECRET?.trim() || "";

const routes = [
  "/api/jobs/billing-process-period-expirations",
  "/api/jobs/billing-process-overdues",
  "/api/billing/dev/process-period-expirations",
  "/api/billing/dev/process-overdues",
];

/** @type {string[]} */
const results = [];

/**
 * @param {string} path
 * @param {Record<string, string>} headers
 */
async function post(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ limit: 1 }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function pass(msg) {
  results.push(`PASS: ${msg}`);
  console.log(`PASS: ${msg}`);
}

function fail(msg, detail) {
  const line = detail ? `FAIL: ${msg} — ${detail}` : `FAIL: ${msg}`;
  results.push(line);
  console.error(line);
}

async function main() {
  console.log("=== S7 BILLING 04.16 — jobs protegidos ===");

  const isDeniedStatus = (status) => status === 401 || status === 403;

  for (const path of routes) {
    const denied = await post(path);
    const isDevMaintenanceRoute = path.startsWith("/api/billing/dev/");
    if (jobSecret && isDeniedStatus(denied.status)) {
      pass(`${path} bloqueia sem X-Job-Secret`);
    } else if (!jobSecret && denied.status >= 200 && denied.status < 300) {
      pass(`${path} acessível sem segredo (ambiente local sem JOB_SECRET)`);
      continue;
    } else if (!jobSecret) {
      fail(`${path} sem JOB_SECRET local`, `status=${denied.status}`);
      continue;
    } else if (isDevMaintenanceRoute && denied.status >= 200 && denied.status < 300) {
      pass(`${path} acessível sem segredo em DEV/local (rota de manutenção)`);
      continue;
    } else if (!isDeniedStatus(denied.status)) {
      fail(`${path} deveria negar sem segredo`, `status=${denied.status}`);
      continue;
    }

    const allowed = await post(path, { "X-Job-Secret": jobSecret });
    if (allowed.status >= 200 && allowed.status < 300) {
      pass(`${path} aceita X-Job-Secret válido`);
    } else {
      fail(`${path} com segredo válido`, `status=${allowed.status} body=${JSON.stringify(allowed.body)}`);
    }
  }

  const failed = results.filter((line) => line.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
