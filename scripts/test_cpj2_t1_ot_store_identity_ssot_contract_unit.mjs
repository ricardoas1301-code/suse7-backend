#!/usr/bin/env node
/**
 * CPJ-2 T1 — seller_companies select for OT store identity must not
 * reference nonexistent avatar_url (silently nulls store fields).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOperationalTasksPayload } from "../src/domain/dashboard/operationalTasksPayload.js";

const root = dirname(fileURLToPath(import.meta.url));
const resolverSrc = readFileSync(
  join(root, "../src/domain/dashboard/resolveMlInitialSyncOperationalPhase.js"),
  "utf8",
);

assert.ok(
  resolverSrc.includes('.select("id, trade_name, company_name, logo_url, document_cnpj")'),
  "OT company select must use logo_url + document_cnpj only",
);
assert.ok(
  !/\.select\([^)]*avatar_url[^)]*\)/.test(resolverSrc),
  "OT company select must NOT request seller_companies.avatar_url",
);

const go = "ab85841e-fa8f-44a1-8db1-853560170241";
const rp = "9ee145d1-b6ff-4a44-a0ca-3bab5d7e9ef0";
const payload = buildOperationalTasksPayload({
  universeStable: true,
  mlAccountSyncStates: [
    {
      marketplace_account_id: rp,
      phase: "in_progress",
      store_name: "SMR - RP",
      store_document_cnpj: "73151110000128",
      store_logo_url: "https://cdn.example/rp.png",
      ml_nickname: "SUPER METALRIO",
      status: "active",
    },
    {
      marketplace_account_id: go,
      phase: "awaiting_start",
      store_name: "SMR - GO",
      store_document_cnpj: "73151110000209",
      store_logo_url: "https://cdn.example/go.png",
      ml_nickname: "CHURRASCO SMR",
      status: "active",
    },
  ],
});

const taskGo = payload.tasks.find((t) => t.marketplace_account_id === go);
const taskRp = payload.tasks.find((t) => t.marketplace_account_id === rp);
assert.equal(taskGo?.title, "Sincronizar Mercado Livre");
assert.equal(taskGo?.store_name, "SMR - GO");
assert.equal(taskGo?.store_document_cnpj, "73151110000209");
assert.ok(taskGo?.store_logo_url);
assert.notEqual(taskGo?.store_name, "CHURRASCO SMR");
assert.equal(taskRp?.store_name, "SMR - RP");
assert.equal(taskRp?.title, "Sincronizando Mercado Livre");

console.log(
  JSON.stringify({
    pass: true,
    test: "cpj2_t1_ot_store_identity_ssot_contract",
    go_store: taskGo?.store_name,
    rp_store: taskRp?.store_name,
  }),
);
