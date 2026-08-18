#!/usr/bin/env node
/**
 * Regressão — rota POST /api/legal/document-acceptances registrada no router único.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const routerSource = readFileSync(join(root, "../api/index.js"), "utf8");

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("router imports legal routes handler", /legalRoutes\.js/.test(routerSource));
assert(
  "router registers document-acceptances path",
  /\/api\/legal/.test(routerSource) &&
    /handleLegalRoutes/.test(routerSource) &&
    /startsWith\("\/api\/legal"\)/.test(routerSource)
);

const handlerMod = await import("../api/index.js");
const handler = handlerMod.default;

/** @param {import("node:http").IncomingMessage & { url?: string; method?: string; headers?: Record<string, string> }} req */
function mockRes() {
  /** @type {{ statusCode: number; headers: Record<string, string>; body: string }} */
  const state = { statusCode: 200, headers: {}, body: "" };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      state.headers[String(k).toLowerCase()] = String(v);
    },
    json(payload) {
      state.body = JSON.stringify(payload);
      return this;
    },
    end(payload) {
      if (payload != null) state.body = String(payload);
    },
  };
}

async function invoke(path, method = "POST", body = null) {
  /** @type {Record<string, string>} */
  const headers = { host: "localhost:3001" };
  if (body != null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  const req = /** @type {any} */ ({
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body != null) yield Buffer.from(body);
    },
  });
  const res = mockRes();
  await handler(req, res);
  return res.state;
}

const optionsResult = await invoke("/api/legal/document-acceptances", "OPTIONS");
assert("OPTIONS not 404", optionsResult.statusCode !== 404);

const postNoAuth = await invoke(
  "/api/legal/document-acceptances",
  "POST",
  JSON.stringify({ document_type: "TERMS_OF_USE" })
);
assert("POST without auth is not 404", postNoAuth.statusCode !== 404);
assert(
  "POST reaches legal handler (auth/config gate, not router miss)",
  [400, 401, 403, 405, 409, 500, 503].includes(postNoAuth.statusCode)
);

const getResult = await invoke("/api/legal/document-acceptances", "GET");
assert("GET returns method not allowed not 404", getResult.statusCode === 405);

const legalRoutesSource = readFileSync(join(root, "../src/legal/routes/legalRoutes.js"), "utf8");
assert("legal idempotency lookup", legalRoutesSource.includes("already_accepted"));
assert("legal rejects body user_id", legalRoutesSource.includes("FORBIDDEN") && legalRoutesSource.includes("body?.user_id"));
assert("legal schema not ready code", legalRoutesSource.includes("SCHEMA_NOT_READY"));

if (failures.length) {
  console.error("FAIL", failures);
  process.exit(1);
}

console.log("OK test_legal_document_acceptances_route_unit", {
  postNoAuthStatus: postNoAuth.statusCode,
  optionsStatus: optionsResult.statusCode,
});
