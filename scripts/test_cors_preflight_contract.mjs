#!/usr/bin/env node
/**
 * P0.4.3 — contrato CORS: OPTIONS preflight deve devolver ACAO para frontend-dev.
 * Falha se allowlist SSOT não incluir origem ou resolvePermittedOrigin regredir.
 */
import assert from "node:assert/strict";
import {
  buildAllowedOrigins,
  CORS_STATIC_ALLOWED_ORIGINS,
  resolvePermittedOrigin,
} from "../src/middlewares/corsAllowlist.js";
import { applyCors } from "../src/middlewares/cors.js";

const FRONTEND_DEV = "https://suse7-frontend-dev.vercel.app";
const UNAUTHORIZED = "https://evil.example.com";

assert(
  CORS_STATIC_ALLOWED_ORIGINS.includes(FRONTEND_DEV),
  "SSOT deve incluir suse7-frontend-dev.vercel.app",
);

const allowed = buildAllowedOrigins({});
assert.equal(resolvePermittedOrigin(FRONTEND_DEV, allowed), FRONTEND_DEV);
assert.equal(resolvePermittedOrigin(UNAUTHORIZED, allowed), null);

/** Simula applyCors OPTIONS (Node handler) */
function simulateOptionsPreflight(origin) {
  const headers = {};
  const res = {
    statusCode: 0,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    end() {},
  };
  const req = {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization",
    },
  };
  const ended = applyCors(req, res);
  assert.equal(ended, true);
  assert.equal(res.statusCode, 204);
  return headers;
}

const preflight = simulateOptionsPreflight(FRONTEND_DEV);
assert.equal(
  preflight["access-control-allow-origin"],
  FRONTEND_DEV,
  "OPTIONS preflight deve espelhar Access-Control-Allow-Origin",
);

const preflightUnauthorized = simulateOptionsPreflight(UNAUTHORIZED);
assert.ok(
  !preflightUnauthorized["access-control-allow-origin"] ||
    preflightUnauthorized["access-control-allow-origin"] === "*",
  "origem não autorizada não deve receber ACAO espelhado (fallback * só sem origin permitida)",
);

/** GET normal */
const getHeaders = {};
const getRes = {
  statusCode: 0,
  setHeader(k, v) {
    getHeaders[k.toLowerCase()] = v;
  },
  end() {},
};
const getEnded = applyCors(
  { method: "GET", headers: { origin: FRONTEND_DEV } },
  getRes,
);
assert.equal(getEnded, false);
assert.equal(getHeaders["access-control-allow-origin"], FRONTEND_DEV);

console.log(
  JSON.stringify({
    ok: true,
    test: "test_cors_preflight_contract",
    frontend_dev: FRONTEND_DEV,
    options_acao: preflight["access-control-allow-origin"],
    get_acao: getHeaders["access-control-allow-origin"],
  }),
);
