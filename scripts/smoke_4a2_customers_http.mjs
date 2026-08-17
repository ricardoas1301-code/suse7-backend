#!/usr/bin/env node
// =============================================================================
// Smoke HTTP — Fase 4A.2 ingestion_health
// Uso: node scripts/smoke_4a2_customers_http.mjs [--api-base=http://localhost:3001]
// Requer API com CUSTOMERS_INGESTION_HEALTH_ENABLED conforme teste (ON/OFF separados).
// =============================================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const expectHealth = process.argv.includes("--expect-off") ? "off" : "on";
const apiBase = (
  process.argv.find((a) => a.startsWith("--api-base="))?.split("=")[1] ||
  process.env.SMOKE_API_BASE ||
  "http://localhost:3001"
).replace(/\/$/, "");

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

async function resolveAccessToken(supabase, userId) {
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) {
    throw new Error(userErr?.message || "Usuário não encontrado");
  }
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    throw new Error(linkErr?.message || "generateLink falhou");
  }
  const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpErr || !otpData?.session?.access_token) {
    throw new Error(otpErr?.message || "verifyOtp falhou");
  }
  return otpData.session.access_token;
}

async function pickSellerUserId(supabase) {
  const { data } = await supabase.from("sales_orders").select("user_id").limit(5000);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of data ?? []) {
    const uid = String(r.user_id ?? "");
    if (!uid) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => a[1] - b[1]);
  return sorted.find(([, c]) => c >= 5)?.[0] ?? sorted[0]?.[0] ?? null;
}

async function fetchCustomers(token) {
  const res = await fetch(`${apiBase}/api/customers?page=1&page_size=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log(`\n=== Smoke 4A.2 HTTP (expect health ${expectHealth.toUpperCase()}) ===\n`);
  console.log("API base:", apiBase);

  if (!url || !serviceKey) {
    fail("env", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const userId = await pickSellerUserId(supabase);
  if (!userId) {
    fail("dataset", "nenhum seller");
    process.exit(1);
  }
  pass("dataset", `user ${userId.slice(0, 8)}…`);

  let token;
  try {
    token = await resolveAccessToken(supabase, userId);
    pass("auth", "JWT obtido");
  } catch (e) {
    fail("auth", e?.message ?? "falhou");
    process.exit(1);
  }

  const { status, body } = await fetchCustomers(token);
  assert(status === 200 && body?.ok === true, "GET /api/customers 200", String(status));

  const ih = body?.summary?.ingestion_health;

  if (expectHealth === "on") {
    assert(isValidHealthShape(ih), "ingestion_health objeto completo", ih?.status ?? "ausente/inválido");
    assert(
      ih?.orders?.materialized + ih?.orders?.pending_materialization === ih?.orders?.total_with_buyer,
      "ingestion_health orders balance",
      "ok",
    );
  } else {
    assert(ih == null, "ingestion_health null (flag OFF)", ih == null ? "null" : `status=${ih?.status}`);
  }

  assert(body?.summary != null, "4A.1 summary", "presente");
  assert(Array.isArray(body?.customers), "4A.1 customers", "array");
  assert(body?.filters != null, "4A.1 filters", "presente");
  assert(body?.pagination != null, "4A.1 pagination", "presente");
  assert(typeof body?.total === "number", "4A.1 total", String(body?.total));
  assert(typeof body?.page === "number", "4A.1 page", String(body?.page));
  assert(typeof body?.page_size === "number", "4A.1 page_size", String(body?.page_size));
  assert(body.pagination?.total === body.total, "4A.1 pagination.total === total", "ok");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} OK ===\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
