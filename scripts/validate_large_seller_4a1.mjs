#!/usr/bin/env node
// =============================================================================
// Validação pós-ingest — seller grande (DEV)
// Uso: node scripts/validate_large_seller_4a1.mjs [--user-id=UUID] [--api-base=URL]
// =============================================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { ingestCustomersFromSales } from "../src/services/customers/customerIngestionService.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const LARGE_SELLER_ID = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const userId =
  process.argv.find((a) => a.startsWith("--user-id="))?.split("=")[1]?.trim() || LARGE_SELLER_ID;
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

async function resolveAccessToken(supabase, uid) {
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(uid);
  if (userErr || !userData?.user?.email) throw new Error(userErr?.message || "user not found");
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) throw new Error(linkErr?.message || "generateLink failed");
  const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpErr || !otpData?.session?.access_token) throw new Error(otpErr?.message || "verifyOtp failed");
  return otpData.session.access_token;
}

async function fetchJson(pathname, token) {
  const t0 = Date.now();
  const res = await fetch(`${apiBase}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - t0 };
}

async function sumGlobalOrders(supabase) {
  const { data } = await supabase.from("s7_global_customers").select("total_orders_global");
  let sum = 0;
  for (const r of data ?? []) sum += Number(r.total_orders_global) || 0;
  return sum;
}

async function main() {
  console.log("\n=== Validação seller grande — 4A.1 DEV ===\n");
  console.log("user_id:", userId);
  console.log("api:", apiBase);

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const globalSumBefore = await sumGlobalOrders(supabase);

  // Idempotência — 2ª passagem (pós-ingest manual)
  const tIngest = Date.now();
  const ingest2 = await ingestCustomersFromSales({
    supabase,
    userId,
    marketplace: "mercado_livre",
  });
  const ingestMs = Date.now() - tIngest;

  assert(ingest2.processedOrders > 0, "idempotência processedOrders", String(ingest2.processedOrders));
  assert(
    ingest2.skippedOrders >= ingest2.processedOrders * 0.95,
    "idempotência skipped ≥95%",
    `skipped=${ingest2.skippedOrders}/${ingest2.processedOrders}`,
  );
  assert(ingest2.upsertedCustomers === 0, "idempotência upserted=0", String(ingest2.upsertedCustomers));
  assert((ingest2.errors?.length ?? 0) === 0, "idempotência errors=0", String(ingest2.errors?.length ?? 0));
  assert(ingestMs < 120000, "idempotência performance re-ingest", `${ingestMs}ms`);

  const globalSumAfter = await sumGlobalOrders(supabase);
  assert(globalSumAfter === globalSumBefore, "total_orders_global sem inflação (sum)", `${globalSumBefore} → ${globalSumAfter}`);

  const { count: mcCount } = await supabase
    .from("marketplace_customers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  assert((mcCount ?? 0) > 0, "marketplace_customers seller grande", String(mcCount ?? 0));

  let token;
  try {
    token = await resolveAccessToken(supabase, userId);
    pass("auth JWT", "ok");
  } catch (e) {
    fail("auth JWT", e?.message ?? "fail");
    process.exit(1);
  }

  const otherUser = userId === LARGE_SELLER_ID ? "7f351439-ea13-44de-8a9c-a2413713f6e4" : LARGE_SELLER_ID;
  let otherToken;
  try {
    otherToken = await resolveAccessToken(supabase, otherUser);
  } catch {
    otherToken = null;
  }

  // GET list paginação
  const p1 = await fetchJson("/api/customers?page=1&page_size=50", token);
  assert(p1.status === 200 && p1.body?.ok, "GET /customers page=1", `${p1.status} ${p1.ms}ms`);
  assert(p1.body?.pagination?.page === 1, "pagination.page", String(p1.body?.pagination?.page));
  assert(p1.body?.pagination?.page_size === 50, "pagination.page_size", String(p1.body?.pagination?.page_size));
  assert(typeof p1.body?.total === "number", "legado total", String(p1.body?.total));
  assert(p1.ms < 15000, "performance list page 1", `${p1.ms}ms`);

  const total = p1.body?.pagination?.total ?? 0;
  if (total > 50) {
    const p2 = await fetchJson("/api/customers?page=2&page_size=50", token);
    assert(p2.status === 200, "GET /customers page=2", `${p2.status} ${p2.ms}ms`);
    const ids1 = new Set((p1.body?.customers ?? []).map((c) => c.id));
    const overlap = (p2.body?.customers ?? []).filter((c) => ids1.has(c.id));
    assert(overlap.length === 0, "paginação sem overlap", `${overlap.length} dupes`);
  }

  // Filtros
  const fMp = await fetchJson("/api/customers?marketplace=mercado_livre&page_size=200", token);
  assert(fMp.status === 200, "GET /customers filtro marketplace", `${fMp.status}`);
  const allMp = (fMp.body?.customers ?? []).every((c) => c.marketplace === "mercado_livre");
  assert(allMp || (fMp.body?.customers ?? []).length === 0, "filtro marketplace aplicado", allMp ? "ok" : "mixed");

  const fStatus = await fetchJson("/api/customers?customer_status=recorrente&page_size=100", token);
  assert(fStatus.status === 200, "GET /customers filtro status", `${fStatus.status}`);
  assert(fStatus.body?.filters?.applied?.customer_status === "recorrente", "filters.applied echo", "ok");

  const fQ = await fetchJson("/api/customers?q=a&page_size=20", token);
  assert(fQ.status === 200, "GET /customers filtro q", `${fQ.status} ${fQ.ms}ms`);

  // Detail
  const customerId = p1.body?.customers?.[0]?.id;
  assert(Boolean(customerId), "customer id para detail", customerId ? String(customerId) : "vazio");

  if (customerId) {
    const detail = await fetchJson(`/api/customers/${customerId}`, token);
    assert(detail.status === 200, "GET /customers/:id", `${detail.status} ${detail.ms}ms`);
    assert(detail.body?.customer?.id === customerId, "detail customer.id", "match");
    assert(detail.body?.metrics != null, "detail metrics", "presente");
    assert(Array.isArray(detail.body?.orders), "detail orders", `${detail.body.orders.length} rows`);
    assert(detail.body?.metrics?.customer_score === null, "customer_score null", "ok");
    assert(detail.ms < 15000, "performance detail", `${detail.ms}ms`);

    if (otherToken) {
      const foreign = await fetchJson(`/api/customers/${customerId}`, otherToken);
      assert(foreign.status === 404, "auth isolation outro seller", String(foreign.status));
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Resultado: ${results.length - failed.length}/${results.length} OK ===\n`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
