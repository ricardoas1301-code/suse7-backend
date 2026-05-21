#!/usr/bin/env node
// =============================================================================
// Smoke HTTP — Fase 4A.3 data_quality_overview
// Uso: node scripts/smoke_4a3_customers_http.mjs [--api-base=http://localhost:3001] [--expect-off]
// =============================================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const expectQuality = process.argv.includes("--expect-off") ? "off" : "on";
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

function isValidOverviewShape(o) {
  if (!o || typeof o !== "object") return false;
  const statuses = new Set(["good", "fair", "poor", "unknown"]);
  if (!statuses.has(String(o.status))) return false;
  if (typeof o.confidence_pct !== "number") return false;
  if (typeof o.computed_at !== "string") return false;
  if ("data_quality" in o) return false;
  if ("dimensions" in o || "signals" in o || "sample_issues" in o) return false;
  return true;
}

async function resolveAccessToken(supabase, userId) {
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) throw new Error(userErr?.message || "Usuário não encontrado");
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) throw new Error(linkErr?.message || "generateLink falhou");
  const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpErr || !otpData?.session?.access_token) throw new Error(otpErr?.message || "verifyOtp falhou");
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

async function main() {
  console.log(`\n=== Smoke 4A.3 HTTP (expect quality ${expectQuality.toUpperCase()}) ===\n`);
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

  const token = await resolveAccessToken(supabase, userId);
  pass("auth", "JWT obtido");

  const res = await fetch(`${apiBase}/api/customers?page=1&page_size=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  assert(res.status === 200 && body?.ok === true, "GET /api/customers 200", String(res.status));

  const overview = body?.summary?.data_quality_overview;

  if (expectQuality === "on") {
    assert(isValidOverviewShape(overview), "data_quality_overview completo", overview?.status ?? "ausente");
    assert(!("score_pct" in (overview ?? {})), "sem score_pct", "ok");
  } else {
    assert(overview == null, "data_quality_overview null (flag OFF)", overview == null ? "null" : overview?.status);
  }

  assert(body?.summary != null, "4A.1 summary", "presente");
  assert(Array.isArray(body?.customers), "4A.1 customers", "array");
  assert(body?.filters != null, "4A.1 filters", "presente");
  assert(body?.pagination != null, "4A.1 pagination", "presente");
  assert(typeof body?.total === "number", "4A.1 total", String(body?.total));
  assert(typeof body?.page === "number", "4A.1 page", String(body?.page));
  assert(typeof body?.page_size === "number", "4A.1 page_size", String(body?.page_size));

  const customerId = body?.customers?.[0]?.id;
  if (expectQuality === "on" && customerId) {
    const detailRes = await fetch(`${apiBase}/api/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detailBody = await detailRes.json().catch(() => ({}));
    assert(detailRes.status === 200, "GET /api/customers/:id 200", String(detailRes.status));
    assert(detailBody?.data_quality?.dimensions != null, "detail dimensions", "presente");
    assert(Array.isArray(detailBody?.data_quality?.sample_issues), "detail sample_issues", "array");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} OK ===\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
