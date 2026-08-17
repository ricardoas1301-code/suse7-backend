#!/usr/bin/env node
// =============================================================================
// Validação — Fase 4A.2 (observabilidade ingestão clientes)
// Uso: node scripts/validate_4a2_ingestion_health.mjs
// =============================================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildCustomersList } from "../src/services/customers/customerReadModelService.js";
import { computeIngestionHealthForScope } from "../src/services/customers/customerIngestionHealthService.js";
import { isCustomersIngestionHealthEnabled } from "../src/services/customers/customerIngestionHealthConstants.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const url = (process.env.SUPABASE_URL || "").trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

/** @type {Array<{ step: string; ok: boolean; detail?: string }>} */
const results = [];

function pass(step, detail) {
  results.push({ step, ok: true, detail });
  console.log(`✅ ${step}${detail ? ` — ${detail}` : ""}`);
}

function fail(step, detail) {
  results.push({ step, ok: false, detail });
  console.error(`❌ ${step}${detail ? ` — ${detail}` : ""}`);
}

function assert(cond, step, detail) {
  if (cond) pass(step, detail);
  else fail(step, detail);
}

function isValidHealthShape(h) {
  if (!h || typeof h !== "object") return false;
  const statuses = new Set(["healthy", "degraded", "critical", "unknown"]);
  if (!statuses.has(String(h.status))) return false;
  if (typeof h.computed_at !== "string") return false;
  if (typeof h.coverage_pct !== "number") return false;
  if (!h.orders || typeof h.orders.total_with_buyer !== "number") return false;
  if (!h.customers || typeof h.customers.materialized !== "number") return false;
  if (!h.global || !("linked" in h.global)) return false;
  if (!h.states || typeof h.states.stale !== "number") return false;
  if (!Array.isArray(h.signals)) return false;
  return true;
}

async function pickSeller(supabase) {
  const { data: orderUsers } = await supabase.from("sales_orders").select("user_id, marketplace").limit(5000);
  /** @type {Map<string, { userId: string; marketplace: string; count: number }>} */
  const byUser = new Map();
  for (const r of orderUsers ?? []) {
    const uid = String(r.user_id ?? "");
    const mp = String(r.marketplace ?? "mercado_livre");
    if (!uid) continue;
    const k = `${uid}|${mp}`;
    const cur = byUser.get(k) ?? { userId: uid, marketplace: mp, count: 0 };
    cur.count += 1;
    byUser.set(k, cur);
  }
  const candidates = [...byUser.values()].sort((a, b) => a.count - b.count);
  return candidates.find((c) => c.count >= 5) ?? candidates[0] ?? null;
}

async function measureListLatency(supabase, userId, enabled) {
  process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED = enabled ? "true" : "false";
  const mod = await import("../src/infra/config.js");
  mod.config.customersIngestionHealthEnabled = enabled;

  const times = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    await buildCustomersList(supabase, userId, { page: 1, page_size: 10 });
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[1];
}

async function main() {
  console.log("\n=== Validate 4A.2 — Ingestion Health ===\n");

  if (!url || !serviceKey) {
    fail("env", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const target = await pickSeller(supabase);
  if (!target) {
    fail("dataset", "nenhum seller com pedidos");
    process.exit(1);
  }
  pass("dataset", `${target.userId.slice(0, 8)}… | ${target.marketplace}`);

  const scope = { userId: target.userId, marketplace: target.marketplace };

  const healthDirect = await computeIngestionHealthForScope(supabase, scope);
  assert(isValidHealthShape(healthDirect), "service shape", healthDirect.status);
  assert(
    healthDirect.orders.materialized + healthDirect.orders.pending_materialization ===
      healthDirect.orders.total_with_buyer,
    "orders materialized + pending = total",
    `${healthDirect.orders.materialized}+${healthDirect.orders.pending_materialization}=${healthDirect.orders.total_with_buyer}`,
  );
  assert(
    healthDirect.coverage_pct >= 0 && healthDirect.coverage_pct <= 100,
    "coverage_pct range",
    String(healthDirect.coverage_pct),
  );

  const { count: pendingDb } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", target.userId)
    .eq("marketplace", target.marketplace)
    .is("customer_ingested_at", null);

  assert(
    healthDirect.orders.pending_materialization === (pendingDb ?? 0),
    "pending_materialization coerente com DB",
    `${healthDirect.orders.pending_materialization} vs ${pendingDb ?? 0}`,
  );

  // Flag OFF
  process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED = "false";
  const configMod = await import("../src/infra/config.js");
  configMod.config.customersIngestionHealthEnabled = false;

  const listOff = await buildCustomersList(supabase, target.userId, { page: 1, page_size: 10 });
  assert(listOff.summary?.ingestion_health == null, "flag OFF → ingestion_health null", "ok");
  assert(listOff.summary?.total_customers != null, "flag OFF backward compatible summary", "ok");

  const latencyOff = await measureListLatency(supabase, target.userId, false);

  // Flag ON
  process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED = "true";
  configMod.config.customersIngestionHealthEnabled = true;

  assert(isCustomersIngestionHealthEnabled(), "flag ON lida", "true");

  const listOn = await buildCustomersList(supabase, target.userId, { page: 1, page_size: 10 });
  assert(isValidHealthShape(listOn.summary?.ingestion_health), "flag ON → ingestion_health presente", listOn.summary?.ingestion_health?.status);
  assert(
    listOn.summary?.ingestion_health?.orders?.pending_materialization === healthDirect.orders.pending_materialization,
    "summary health pending coerente",
    "ok",
  );

  const latencyOn = await measureListLatency(supabase, target.userId, true);
  const delta = latencyOn - latencyOff;

  pass("latency OFF p50", `${latencyOff}ms`);
  pass("latency ON p50", `${latencyOn}ms`);
  pass("latency delta", `${delta >= 0 ? "+" : ""}${delta}ms`);

  assert(delta < 1500, "latência delta aceitável (<1500ms)", `${delta}ms`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} OK ===\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
