#!/usr/bin/env node
/**
 * CPJ-2 T1 — resolver account-aware (source contract).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(
  path.join(root, "src/domain/dashboard/resolveMlInitialSyncOperationalPhase.js"),
  "utf8",
);
const payloadSrc = fs.readFileSync(
  path.join(root, "src/domain/dashboard/operationalTasksPayload.js"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260830120000_cpj2_t1_ml_tokens_multiconta.sql"),
  "utf8",
);

/** @type {string[]} */
const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("resolver returns accounts array", src.includes("accounts: perAccount"));
assert("resolver does not use only rows[0] as sole identity", !src.includes("const primaryAccountId = String(rows[0]"));
assert("payload emits per-account dedupe keys", payloadSrc.includes("ml_initial_sync_pending:${accountId}"));
assert("migration drops legacy unique pair", migration.includes("ARRAY['user_id', 'marketplace']"));
assert("migration creates triple unique", migration.includes("ml_tokens_user_marketplace_ml_user_uidx"));
assert("migration adds marketplace_account_id", migration.includes("ADD COLUMN IF NOT EXISTS marketplace_account_id"));

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ pass: true, test: "cpj2_t1_multiconta_source_contract_unit" }));
