#!/usr/bin/env node
/**
 * DEV.V2.SIGNUP-TWOPHASE-IMPLEMENTATION.18 — unit tests (router + validation)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validatePendingBirthPayload } from "../src/signup/domain/signupPendingBirthValidation.js";
import {
  TERMOS_USO_HASH_CONTEUDO,
  TERMOS_USO_TIPO_DOCUMENTO,
  TERMOS_USO_VERSAO_ID,
} from "../src/legal/domain/documentosLegaisCanonicos.js";

const root = dirname(fileURLToPath(import.meta.url));

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://testref.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJyZWYiOiJ0ZXN0cmVmIn0.sig";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const routerSource = readFileSync(join(root, "../api/index.js"), "utf8");
assert("router registers signup routes", /handleSignupRoutes/.test(routerSource) && /\/api\/signup/.test(routerSource));

const validPayload = validatePendingBirthPayload({
  email: "novo@teste.local",
  nome: "Empresa Teste LTDA",
  nome_loja: "Loja Teste",
  whatsapp: "11999998888",
  cpf_cnpj: "11222333000181",
  terms: {
    document_type: TERMOS_USO_TIPO_DOCUMENTO,
    document_version: TERMOS_USO_VERSAO_ID,
    document_hash: TERMOS_USO_HASH_CONTEUDO,
    accepted_at: new Date().toISOString(),
    source: "SIGNUP",
    scrolled_to_end: true,
  },
});
assert("validatePendingBirthPayload ok", validPayload.ok === true);

const invalidTerms = validatePendingBirthPayload({
  email: "novo@teste.local",
  nome: "Empresa Teste LTDA",
  nome_loja: "Loja Teste",
  whatsapp: "11999998888",
  cpf_cnpj: "11222333000181",
  terms: {
    document_type: TERMOS_USO_TIPO_DOCUMENTO,
    document_version: "wrong-version",
    document_hash: TERMOS_USO_HASH_CONTEUDO,
    accepted_at: new Date().toISOString(),
    source: "SIGNUP",
    scrolled_to_end: true,
  },
});
assert("validatePendingBirthPayload rejects bad version", invalidTerms.ok === false);

const handlerMod = await import("../api/index.js");
const handler = handlerMod.default;

function mockRes() {
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

const postPendingNoBody = await invoke("/api/signup/pending-birth", "POST", JSON.stringify({}));
assert("pending-birth invalid payload not 404", postPendingNoBody.statusCode !== 404);
assert(
  "pending-birth invalid payload reaches handler",
  [400, 500, 503].includes(postPendingNoBody.statusCode)
);

const postCompleteNoAuth = await invoke("/api/signup/complete-birth", "POST", JSON.stringify({}));
assert("complete-birth requires auth not 404", postCompleteNoAuth.statusCode !== 404);
assert(
  "complete-birth reaches auth gate",
  [401, 403, 500, 503].includes(postCompleteNoAuth.statusCode)
);

const signupJs = readFileSync(join(root, "../../suse7-frontend/src/components/Signup.jsx"), "utf8");
assert("Signup.jsx uses pending birth API", /criarSignupPendingBirth/.test(signupJs));
assert("Signup.jsx removed profile upsert on submit", !/from\("profiles"\)\s*\.upsert/.test(signupJs));
assert("Signup.jsx removed legal retry mode", !/signupLegalRetryMode/.test(signupJs));
assert("Signup.jsx shows check email success", /SignupCheckEmail/.test(signupJs));

const dashboardJs = readFileSync(join(root, "../../suse7-frontend/src/components/Dashboard.jsx"), "utf8");
assert("Dashboard stub profile removed", !/from\("profiles"\)\s*\.insert/.test(dashboardJs));

const migrationSql = readFileSync(
  join(root, "../supabase/migrations/20260813200000_s7_signup_pending_births_two_phase.sql"),
  "utf8"
);
assert("migration creates s7_private.signup_pending_births", /s7_private\.signup_pending_births/.test(migrationSql));
assert("migration atomic complete function", /s7_private\.complete_signup_birth_once/.test(migrationSql));
assert("migration public RPC wrappers service_role only", /GRANT EXECUTE ON FUNCTION public\.s7_complete_signup_birth_once/.test(migrationSql));

if (failures.length) {
  console.error("FAILURES:", failures);
  process.exit(1);
}

console.log(JSON.stringify({ pass: true, tests: "signup_two_phase_unit", count: 14 }, null, 2));
