#!/usr/bin/env node
/**
 * OAuth fail-safe — conta não permanece active sem token persistido
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callbackSrc = fs.readFileSync(path.join(backendRoot, "src/handlers/ml/callback.js"), "utf8");
const persistSrc = fs.readFileSync(
  path.join(backendRoot, "src/handlers/ml/_helpers/mlOAuthConnectPersistence.js"),
  "utf8",
);

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("compensate helper exported", persistSrc.includes("compensarContaMarketplaceFalhaPersistenciaToken"));
assert("compensate sets invalid status", persistSrc.includes('status: "invalid"'));
assert("callback imports compensate", callbackSrc.includes("compensarContaMarketplaceFalhaPersistenciaToken"));
assert(
  "callback compensates on persist failure",
  /!persistResult\?\.ok[\s\S]*compensarContaMarketplaceFalhaPersistenciaToken/.test(callbackSrc),
);
assert(
  "legacy schema 42P10 falls through to insert/update",
  persistSrc.includes("persist_ml_tokens_legacy_unique_fallback") &&
    !persistSrc.includes("persist_tokens_legacy_unique_blocked") &&
    !persistSrc.includes("ml_tokens_multi_account_unique_required"),
);

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ pass: true, test: "ml_oauth_token_persist_failsafe_unit", cases: 5 }, null, 2));
