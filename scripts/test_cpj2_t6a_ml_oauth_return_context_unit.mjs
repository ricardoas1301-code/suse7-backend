#!/usr/bin/env node
/**
 * CPJ-2 T6A — contrato de retorno pós-OAuth ML (origem allowlisted + state assinado).
 */
import assert from "node:assert/strict";
import {
  buildMlOAuthIntegrationRedirectUrl,
  buildSignedMlOAuthState,
  resolveMlOAuthCallbackFrontendBase,
  resolveTrustedMlOAuthFrontendOrigin,
  verifySignedMlOAuthState,
} from "../src/handlers/ml/_helpers/mlOAuthReturnContext.js";

const ORIG_LOCAL = "http://localhost:5173";
const ORIG_PROD = "https://suse7.com.br";
const ORIG_HOSTED = "https://suse7-frontend-dev.vercel.app";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-0123456789abcdef";
process.env.FRONTEND_URL = ORIG_LOCAL;
process.env.ML_OAUTH_ALLOWED_FRONTEND_ORIGINS = ORIG_HOSTED;

/** @type {string[]} */
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}`, err instanceof Error ? err.message : err);
  }
}

test("LOCAL connect origin allowlisted", () => {
  const r = resolveTrustedMlOAuthFrontendOrigin({
    queryOrigin: ORIG_LOCAL,
    fallbackFrontendUrl: ORIG_LOCAL,
  });
  assert.equal(r.ok, true);
  assert.equal(r.origin, ORIG_LOCAL);
});

test("HOSTED connect origin allowlisted via env list", () => {
  const r = resolveTrustedMlOAuthFrontendOrigin({
    queryOrigin: ORIG_HOSTED,
    fallbackFrontendUrl: ORIG_LOCAL,
  });
  assert.equal(r.ok, true);
  assert.equal(r.origin, ORIG_HOSTED);
});

test("PROD connect origin allowlisted", () => {
  const r = resolveTrustedMlOAuthFrontendOrigin({ queryOrigin: ORIG_PROD });
  assert.equal(r.ok, true);
  assert.equal(r.origin, ORIG_PROD);
});

test("invalid origin fail-closed", () => {
  const r = resolveTrustedMlOAuthFrontendOrigin({
    queryOrigin: "https://evil.example.com",
  });
  assert.equal(r.ok, false);
});

test("signed state roundtrip local", () => {
  const built = buildSignedMlOAuthState({ frontendOrigin: ORIG_LOCAL });
  assert.equal(built.ok, true);
  const verified = verifySignedMlOAuthState(built.state);
  assert.equal(verified.ok, true);
  assert.equal(verified.frontendOrigin, ORIG_LOCAL);
  assert.equal(verified.returnPath, "/perfil/integracoes/mercado-livre");
});

test("callback resolves local from signed state", () => {
  const built = buildSignedMlOAuthState({ frontendOrigin: ORIG_LOCAL });
  const resolved = resolveMlOAuthCallbackFrontendBase({
    stateParam: built.state,
    envFrontendUrl: ORIG_PROD,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.base, ORIG_LOCAL);
  assert.equal(resolved.source, "signed_state");
});

test("callback hosted state does not cross to prod env fallback incorrectly", () => {
  const built = buildSignedMlOAuthState({ frontendOrigin: ORIG_HOSTED });
  const resolved = resolveMlOAuthCallbackFrontendBase({
    stateParam: built.state,
    envFrontendUrl: ORIG_PROD,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.base, ORIG_HOSTED);
});

test("legacy state uses env fallback", () => {
  const resolved = resolveMlOAuthCallbackFrontendBase({
    stateParam: "legacy-random-token-only",
    envFrontendUrl: ORIG_PROD,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.base, ORIG_PROD);
  assert.equal(resolved.source, "legacy_state_env_fallback");
});

test("external return path rejected", () => {
  const built = buildSignedMlOAuthState({
    frontendOrigin: ORIG_LOCAL,
    returnPath: "https://evil.example.com/steal",
  });
  assert.equal(built.ok, false);
  assert.equal(built.reason, "return_path_rejected");
});

test("tampered signature rejected", () => {
  const built = buildSignedMlOAuthState({ frontendOrigin: ORIG_LOCAL });
  const parts = built.state.split(".");
  const tampered = `${parts[0]}.${parts[1]}.deadbeef`;
  const verified = verifySignedMlOAuthState(tampered);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "state_signature_invalid");
});

test("expired state rejected", () => {
  const built = buildSignedMlOAuthState({
    frontendOrigin: ORIG_LOCAL,
    nowMs: Date.now() - 20 * 60 * 1000,
  });
  const verified = verifySignedMlOAuthState(built.state, { nowMs: Date.now() });
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "state_expired");
});

test("integration redirect url has no secrets", () => {
  const url = buildMlOAuthIntegrationRedirectUrl(
    ORIG_PROD,
    "/perfil/integracoes/mercado-livre",
    "ml=connected&marketplace_account_id=11111111-1111-4111-8111-111111111111",
  );
  assert.ok(url.startsWith(`${ORIG_PROD}/perfil/integracoes/mercado-livre?`));
  assert.ok(!url.includes("access_token"));
  assert.ok(!url.includes("refresh_token"));
});

test("open redirect via origin blocked at connect", () => {
  const r = resolveTrustedMlOAuthFrontendOrigin({
    queryOrigin: "https://attacker.io",
    headerReferer: "https://attacker.io/foo",
  });
  assert.equal(r.ok, false);
});

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    pass: true,
    test: "cpj2_t6a_ml_oauth_return_context_unit",
    cases: 13,
  }),
);
