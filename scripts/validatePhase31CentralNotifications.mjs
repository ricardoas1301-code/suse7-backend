#!/usr/bin/env node
/**
 * Validação Fase 3.1 — S7 Central Notification Engine (DEV)
 *
 * Uso:
 *   node scripts/validatePhase31CentralNotifications.mjs
 *
 * Requer: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (ou .env.local)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { publishNotificationEvent } from "../src/domain/notifications/central/index.js";
import { S7_NOTIFICATION_CATEGORY } from "../src/domain/notifications/central/constants/categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadEnvLocal() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvLocal();

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !key) {
  console.error("FAIL: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

/** @type {Array<{ name: string, pass: boolean, detail?: string }>} */
const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function tableExists(table) {
  const { error } = await supabase.from(table).select("id", { count: "exact", head: true }).limit(1);
  if (!error) return true;
  const msg = error.message ?? "";
  return !msg.includes("does not exist") && !msg.includes("schema cache");
}

async function findTestSeller() {
  const email = process.env.S7_BILLING_DEV_VALIDATE_EMAIL ?? "s7-billing-dev-validate@suse7.local";
  const { data: list } = await supabase.auth.admin.listUsers({ perPage: 200 });
  const user = list?.users?.find((u) => String(u.email ?? "").toLowerCase() === email.toLowerCase());
  return user?.id ?? null;
}

async function main() {
  console.log("=== S7 Phase 3.1 — Central Notification Engine ===\n");

  const tables = [
    "s7_notification_categories",
    "s7_notification_event_types",
    "s7_notification_events",
    "s7_notification_preferences",
    "s7_notification_recipients",
    "s7_notification_templates",
    "s7_notification_dispatches",
    "s7_notification_delivery_logs",
  ];

  for (const t of tables) {
    const ok = await tableExists(t);
    record(`table:${t}`, ok, ok ? "" : "apply migration 20260522140000");
    if (!ok) {
      console.error("\nAbort: migration not applied on this database.");
      process.exit(1);
    }
  }

  const sellerId = await findTestSeller();
  record("test_seller", Boolean(sellerId), sellerId ?? "no dev validate user");
  if (!sellerId) {
    process.exit(1);
  }

  const idempotencyKey = `phase31:validate:${Date.now()}`;
  const published = await publishNotificationEvent(supabase, {
    category: S7_NOTIFICATION_CATEGORY.BILLING,
    type: "PAYMENT_CONFIRMED",
    seller_id: sellerId,
    payload: { plan_name: "Plano Teste Phase 3.1" },
    correlation_id: idempotencyKey,
    idempotency_key: idempotencyKey,
    source_module: "phase31_validate",
  });

  const firstDispatchesInserted = published.dispatches?.inserted ?? 0;

  record(
    "publishNotificationEvent",
    published.ok === true && published.event?.id != null,
    published.error ?? `event_id=${published.event?.id}`
  );

  record(
    "first_publish_dispatches",
    firstDispatchesInserted >= 1,
    `dispatches_inserted=${firstDispatchesInserted}`
  );

  if (!published.ok || !published.event?.id) {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
    console.log("\nHint: apply migration 20260522140000_s7_central_notification_engine_phase31.sql on Supabase DEV.");
    process.exit(1);
  }

  const republish = await publishNotificationEvent(supabase, {
    category: S7_NOTIFICATION_CATEGORY.BILLING,
    type: "PAYMENT_CONFIRMED",
    seller_id: sellerId,
    payload: { plan_name: "Plano Teste Phase 3.1" },
    idempotency_key: idempotencyKey,
    source_module: "phase31_validate",
  });

  const republishDispatchesInserted = republish.dispatches?.inserted ?? -1;

  record(
    "idempotency",
    republish.ok && republish.idempotent === true,
    `same_event=${republish.event?.id === published.event?.id}`
  );

  record(
    "idempotent_no_redispatch",
    republishDispatchesInserted === 0,
    `dispatches_inserted=${republishDispatchesInserted}`
  );

  const { count: dispatchCount } = await supabase
    .from("s7_notification_dispatches")
    .select("id", { count: "exact", head: true })
    .eq("event_id", published.event.id);

  record(
    "dispatches_created",
    dispatchCount === 1,
    `count=${dispatchCount ?? 0} (expected 1)`
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
