#!/usr/bin/env node
/**
 * Foundation 0 — allowlist CORS canônica (sem rede).
 */
import { applyCors } from "../src/middlewares/cors.js";

/** @type {Array<{ name: string; detail: unknown }>} */
const failures = [];

function fail(name, detail) {
  failures.push({ name, detail });
}

/**
 * @param {string} origin
 * @param {string} method
 */
function runCorsProbe(origin, method = "GET") {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
    },
    end() {},
  };
  const req = {
    method,
    headers: { origin },
  };
  applyCors(req, res);
  return {
    statusCode: res.statusCode,
    acao: headers["access-control-allow-origin"] ?? null,
  };
}

const localhost = runCorsProbe("http://localhost:5173");
if (localhost.acao !== "http://localhost:5173") fail("localhost_permitido", localhost);

const frontendDev = runCorsProbe("https://suse7-frontend-dev.vercel.app");
if (frontendDev.acao !== "https://suse7-frontend-dev.vercel.app") fail("frontend_dev_permitido", frontendDev);

const prod = runCorsProbe("https://suse7.com.br");
if (prod.acao !== "https://suse7.com.br") fail("prod_permitido", prod);

const unknown = runCorsProbe("https://evil.example.com");
if (unknown.acao != null && unknown.acao !== "") fail("origin_desconhecido_bloqueado", unknown);

const preflight = runCorsProbe("https://suse7-frontend-dev.vercel.app", "OPTIONS");
if (preflight.statusCode !== 204) fail("preflight_status_204", preflight);
if (preflight.acao !== "https://suse7-frontend-dev.vercel.app") fail("preflight_acao_frontend_dev", preflight);

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "cors_allowlist_foundation0",
      cases: ["localhost", "frontend_dev", "prod", "unknown_blocked", "preflight"],
    },
    null,
    2,
  ),
);
