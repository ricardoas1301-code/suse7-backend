#!/usr/bin/env node
/**
 * Foundation 0.1B — matriz CORS (SSOT + serverless + edge middleware).
 */
import { applyCors } from "../src/middlewares/cors.js";
import {
  buildCorsResponseHeaders,
  resolvePermittedOrigin,
} from "../src/shared/corsContract.js";
import edgeMiddleware from "../middleware.js";

/** @type {Array<{ name: string; detail: unknown }>} */
const failures = [];

function fail(name, detail) {
  failures.push({ name, detail });
}

/**
 * @param {string} origin
 * @param {string} method
 * @param {string | null} [acrh]
 */
function runServerlessCors(origin, method = "GET", acrh = null) {
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
    headers: {
      origin,
      ...(acrh ? { "access-control-request-headers": acrh } : {}),
    },
  };
  const finished = applyCors(req, res);
  return {
    finished,
    statusCode: res.statusCode,
    acao: headers["access-control-allow-origin"] ?? null,
    allowHeaders: headers["access-control-allow-headers"] ?? null,
    allowMethods: headers["access-control-allow-methods"] ?? null,
    allowCredentials: headers["access-control-allow-credentials"] ?? null,
  };
}

/**
 * @param {string} origin
 * @param {string} method
 * @param {string | null} [acrh]
 */
function runEdgeOptions(origin, method = "OPTIONS", acrh = "authorization,content-type") {
  const req = new Request("https://suse7-backend-dev.vercel.app/api/dashboard/operational-tasks", {
    method,
    headers: {
      Origin: origin,
      ...(method === "OPTIONS"
        ? {
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": acrh,
          }
        : {}),
    },
  });
  const res = edgeMiddleware(req);
  if (!(res instanceof Response)) {
    return { kind: "next", acao: null, status: null };
  }
  return {
    kind: "response",
    status: res.status,
    acao: res.headers.get("Access-Control-Allow-Origin"),
    allowHeaders: res.headers.get("Access-Control-Allow-Headers"),
    allowMethods: res.headers.get("Access-Control-Allow-Methods"),
    allowCredentials: res.headers.get("Access-Control-Allow-Credentials"),
  };
}

const origins = {
  localhost: "http://localhost:5173",
  frontendDev: "https://suse7-frontend-dev.vercel.app",
  prod: "https://suse7.com.br",
  unknown: "https://evil.example.com",
};

// A–H serverless matrix
for (const [label, origin] of Object.entries(origins)) {
  const get = runServerlessCors(origin, "GET");
  const opt = runServerlessCors(origin, "OPTIONS", "authorization,content-type");

  if (label === "unknown") {
    if (get.acao) fail(`${label}_get_bloqueado`, get);
    if (opt.acao) fail(`${label}_options_bloqueado`, opt);
  } else {
    if (get.acao !== origin) fail(`${label}_get_permitido`, get);
    if (opt.statusCode !== 204) fail(`${label}_options_status`, opt);
    if (opt.acao !== origin) fail(`${label}_options_permitido`, opt);
    if (!String(opt.allowMethods || "").includes("GET")) fail(`${label}_options_methods`, opt);
  }
}

// I — Authorization requested header
const authHdr = runServerlessCors(origins.frontendDev, "OPTIONS", "authorization,content-type");
if (!String(authHdr.allowHeaders || "").toLowerCase().includes("authorization")) {
  fail("options_authorization_header", authHdr);
}

// J/K — OPTIONS encerra sem auth (finished=true, 204)
const optFinish = runServerlessCors(origins.frontendDev, "OPTIONS");
if (!optFinish.finished || optFinish.statusCode !== 204) {
  fail("options_nao_executa_negocio", optFinish);
}

// Edge middleware — preflight (causa raiz F0.1B)
for (const [label, origin] of Object.entries(origins)) {
  const edge = runEdgeOptions(origin);
  if (label === "unknown") {
    if (edge.acao) fail(`edge_${label}_bloqueado`, edge);
  } else {
    if (edge.status !== 204) fail(`edge_${label}_status`, edge);
    if (edge.acao !== origin) fail(`edge_${label}_acao`, edge);
    if (!String(edge.allowHeaders || "").toLowerCase().includes("authorization")) {
      fail(`edge_${label}_allow_headers`, edge);
    }
  }
}

// SSOT resolvePermittedOrigin
if (resolvePermittedOrigin(origins.frontendDev, null) !== origins.frontendDev) {
  fail("ssot_frontend_dev", null);
}
if (resolvePermittedOrigin(origins.unknown, null) != null) {
  fail("ssot_unknown", null);
}

// buildCorsResponseHeaders nunca usa wildcard
const blocked = buildCorsResponseHeaders({ originPermitida: null, method: "OPTIONS" });
if (blocked["Access-Control-Allow-Origin"] === "*") {
  fail("sem_wildcard", blocked);
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "cors_preflight_foundation0_1b_matrix",
      cases: [
        "serverless_get_options_localhost",
        "serverless_get_options_frontend_dev",
        "serverless_get_options_prod",
        "serverless_unknown_blocked",
        "options_authorization_header",
        "options_short_circuit",
        "edge_options_localhost",
        "edge_options_frontend_dev",
        "edge_options_prod",
        "edge_unknown_blocked",
        "ssot_no_wildcard",
      ],
    },
    null,
    2,
  ),
);
