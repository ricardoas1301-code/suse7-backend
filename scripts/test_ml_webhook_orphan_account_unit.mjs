#!/usr/bin/env node
/**
 * Webhook ML — seller externo sem marketplace_account interna.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMlWebhookTerminalIgnoredError } from "../src/handlers/ml/_helpers/mlWebhookOrderProcessorOutcome.js";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert(
  "orphan context terminal ignored",
  isMlWebhookTerminalIgnoredError({ code: "WEBHOOK_ACCOUNT_CONTEXT_NOT_FOUND" }),
);

const serviceSource = readFileSync(join(root, "../src/handlers/ml/mlWebhookService.js"), "utf8");
const routesSource = readFileSync(join(root, "../src/handlers/ml/mlWebhookRoutes.js"), "utf8");
const repoSource = readFileSync(join(root, "../src/handlers/ml/mlWebhookRepository.js"), "utf8");

assert("ingest checks orphan seller", /isOrphanMarketplaceSeller/.test(serviceSource));
assert("ingest saves ignored orphan", /saveMlWebhookEventIgnored/.test(serviceSource));
assert(
  "routes skip job for ignored",
  /result\.status[^\n]+ignored/.test(routesSource),
);
assert("ignored repo status terminal", /status:\s*"ignored"/.test(repoSource));
assert("ignored repo sets completed_at", /completed_at:/.test(repoSource));

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "ml_webhook_orphan_account_unit",
      cases: 6,
    },
    null,
    2,
  ),
);
