#!/usr/bin/env node
// =============================================================================
// Validação — Fase 4A.3 (data quality clientes)
// Uso: node scripts/validate_4a3_data_quality.mjs
// =============================================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildCustomersList, buildCustomerDetail } from "../src/services/customers/customerReadModelService.js";
import { isCustomersDataQualityEnabled } from "../src/services/customers/customerDataQualityConstants.js";
import { computeDataQualityOverviewFromRows } from "../src/services/customers/customerDataQualityService.js";

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

function isValidOverviewShape(o) {
  if (!o || typeof o !== "object") return false;
  const statuses = new Set(["good", "fair", "poor", "unknown"]);
  if (!statuses.has(String(o.status))) return false;
  if (typeof o.confidence_pct !== "number") return false;
  if (typeof o.computed_at !== "string") return false;
  if ("signals" in o || "dimensions" in o || "sample_issues" in o) return false;
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
  process.env.CUSTOMERS_DATA_QUALITY_ENABLED = enabled ? "true" : "false";
  const mod = await import("../src/infra/config.js");
  mod.config.customersDataQualityEnabled = enabled;

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
  console.log("\n=== Validate 4A.3 — Data Quality ===\n");

  if (!url || !serviceKey) {
    fail("env", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const target = await pickSeller(supabase);
  if (!target) {
    fail("dataset", "nenhum seller");
    process.exit(1);
  }
  pass("dataset", `${target.userId.slice(0, 8)}…`);

  // Flag OFF
  process.env.CUSTOMERS_DATA_QUALITY_ENABLED = "false";
  const configMod = await import("../src/infra/config.js");
  configMod.config.customersDataQualityEnabled = false;

  const listOff = await buildCustomersList(supabase, target.userId, { page: 1, page_size: 10 });
  assert(listOff.summary?.data_quality_overview == null, "flag OFF → overview null", "ok");
  assert(listOff.summary?.total_customers != null, "4A.1 summary intacto (OFF)", "ok");

  const latencyOff = await measureListLatency(supabase, target.userId, false);

  // Flag ON
  process.env.CUSTOMERS_DATA_QUALITY_ENABLED = "true";
  configMod.config.customersDataQualityEnabled = true;
  assert(isCustomersDataQualityEnabled(), "flag ON lida", "true");

  const listOn = await buildCustomersList(supabase, target.userId, { page: 1, page_size: 10 });
  const o = listOn.summary?.data_quality_overview;
  assert(isValidOverviewShape(o), "overview shape listagem", o?.status ?? "inválido");
  assert(o?.confidence_pct >= 0 && o?.confidence_pct <= 100, "confidence_pct range", String(o?.confidence_pct));
  assert(listOn.summary?.ingestion_health == null || typeof listOn.summary?.ingestion_health === "object", "4A.2 não quebrado", "ok");

  const firstId = listOn.customers[0]?.id;
  if (firstId) {
    const detail = await buildCustomerDetail(supabase, target.userId, String(firstId), {});
    assert(detail?.data_quality != null, "detail data_quality presente", detail?.data_quality?.status);
    assert(detail.data_quality.dimensions != null, "detail dimensions", "presente");
    assert(Array.isArray(detail.data_quality.signals), "detail signals", "array");
    assert(Array.isArray(detail.data_quality.sample_issues), "detail sample_issues", "array");
    assert(detail.metrics?.customer_score === null, "sem score cliente", "null");
  }

  const latencyOn = await measureListLatency(supabase, target.userId, true);
  const delta = latencyOn - latencyOff;
  pass("latency OFF p50", `${latencyOff}ms`);
  pass("latency ON p50", `${latencyOn}ms`);
  pass("latency delta", `${delta >= 0 ? "+" : ""}${delta}ms`);
  assert(delta < 800, "latência delta aceitável (<800ms)", `${delta}ms`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} OK ===\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
