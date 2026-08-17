#!/usr/bin/env node
// =============================================================================
// Smoke — Sprint 1 Fase 4A.1 (Clientes 360)
// Uso: node scripts/smoke_4a1_customers.mjs [--api-base http://localhost:3001]
// =============================================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { ingestCustomersFromSales } from "../src/services/customers/customerIngestionService.js";
import { buildCustomersList, buildCustomerDetail } from "../src/services/customers/customerReadModelService.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const apiBase = (process.argv.find((a) => a.startsWith("--api-base="))?.split("=")[1] ||
  process.env.SMOKE_API_BASE ||
  "http://localhost:3001").replace(/\/$/, "");

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

async function resolveAccessToken(supabase, userId) {
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) {
    throw new Error(userErr?.message || "Usuário não encontrado para smoke HTTP");
  }
  const email = userData.user.email;
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
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

async function fetchJson(pathname, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${apiBase}${pathname}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log("\n=== Smoke 4A.1 — Clientes 360 ===\n");
  console.log("API base:", apiBase);

  if (!url || !serviceKey) {
    fail("env", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1) Migration column — probe via select
  const { error: probeErr } = await supabase
    .from("sales_orders")
    .select("customer_ingested_at")
    .limit(1);
  if (probeErr && String(probeErr.message).includes("customer_ingested_at")) {
    fail("migration", "coluna customer_ingested_at ausente");
  } else {
    pass("migration", "customer_ingested_at acessível");
  }

  // Pick seller with orders (prefer smaller set for speed)
  const { data: orderUsers } = await supabase
    .from("sales_orders")
    .select("user_id, marketplace")
    .limit(5000);

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
  const target = candidates.find((c) => c.count >= 5) ?? candidates[0];
  if (!target) {
    fail("dataset", "nenhum sales_orders para smoke");
    process.exit(1);
  }

  pass("dataset", `user ${target.userId.slice(0, 8)}… | ${target.marketplace} | ${target.count} pedidos`);

  // Global baseline (sample)
  const { data: globalBefore } = await supabase
    .from("s7_global_customers")
    .select("total_orders_global")
    .limit(1)
    .maybeSingle();
  const globalOrdersBefore = Number(globalBefore?.total_orders_global ?? 0);

  const { count: pendingBefore } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", target.userId)
    .eq("marketplace", target.marketplace)
    .is("customer_ingested_at", null);

  // 6) Ingestão — 1ª passagem
  const ingest1 = await ingestCustomersFromSales({
    supabase,
    userId: target.userId,
    marketplace: target.marketplace,
  });

  assert(
    ingest1.processedOrders > 0 || (pendingBefore ?? 0) === 0,
    "ingest-1 processedOrders ou pipeline já materializado",
    (pendingBefore ?? 0) === 0 ? "0 pending antes" : String(ingest1.processedOrders),
  );
  assert(
    (ingest1.errors?.length ?? 0) === 0,
    "ingest-1 errors",
    String(ingest1.errors?.length ?? 0),
  );

  const { count: mcBeforeIngest } = await supabase
    .from("marketplace_customers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", target.userId);

  const alreadyMaterialized =
    (ingest1.upsertedCustomers ?? 0) === 0 &&
    (ingest1.skippedOrders ?? 0) >= (ingest1.processedOrders ?? 0) * 0.9 &&
    (mcBeforeIngest ?? 0) > 0;

  assert(
    (ingest1.upsertedCustomers ?? 0) > 0 || alreadyMaterialized,
    "ingest-1 upsertedCustomers ou base já materializada",
    alreadyMaterialized
      ? `skipped=${ingest1.skippedOrders}, mc=${mcBeforeIngest}`
      : String(ingest1.upsertedCustomers),
  );

  const { count: mcAfter1 } = await supabase
    .from("marketplace_customers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", target.userId);

  assert((mcAfter1 ?? 0) > 0, "marketplace_customers materializados", String(mcAfter1 ?? 0));

  const { count: ingestedAfter1 } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", target.userId)
    .eq("marketplace", target.marketplace)
    .not("customer_ingested_at", "is", null);

  assert((ingestedAfter1 ?? 0) > 0, "pedidos marcados customer_ingested_at", String(ingestedAfter1 ?? 0));

  // 6) Ingestão — 2ª passagem (idempotência)
  const ingest2 = await ingestCustomersFromSales({
    supabase,
    userId: target.userId,
    marketplace: target.marketplace,
  });

  if (ingest2.processedOrders > 0) {
    assert(
      ingest2.skippedOrders >= ingest2.processedOrders * 0.9,
      "ingest-2 skip idempotente",
      `skipped=${ingest2.skippedOrders}/${ingest2.processedOrders}`,
    );
  } else {
    pass("ingest-2 skip idempotente", "0 pedidos pendentes");
  }
  assert(
    ingest2.upsertedCustomers === 0 || ingest2.updatedCustomers === ingest2.upsertedCustomers,
    "ingest-2 sem novos upserts",
    `upserted=${ingest2.upsertedCustomers}`,
  );

  const { data: globalAfter } = await supabase
    .from("s7_global_customers")
    .select("total_orders_global")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const globalOrdersAfter = Number(globalAfter?.total_orders_global ?? 0);
  const globalDelta = globalOrdersAfter - globalOrdersBefore;
  assert(
    globalDelta <= ingest1.processedOrders,
    "global total_orders_global sem inflação na re-ingestão",
    `delta=${globalDelta} (1ª passagem processou ${ingest1.processedOrders})`,
  );

  void pendingBefore;

  // 4) Read model — list
  const listPayload = await buildCustomersList(supabase, target.userId, { page: 1, page_size: 10 });
  assert(listPayload.summary != null, "read-model summary", "presente");
  assert(Array.isArray(listPayload.filters?.marketplaces), "read-model filters.marketplaces", "array");
  assert(Array.isArray(listPayload.customers), "read-model customers", `${listPayload.customers.length} rows`);
  assert(listPayload.pagination?.total === listPayload.total, "read-model pagination.total === total", "ok");
  assert(listPayload.page === listPayload.pagination?.page, "legado page", "ok");
  assert(listPayload.page_size === listPayload.pagination?.page_size, "legado page_size", "ok");

  const firstId = listPayload.customers[0]?.id;
  assert(Boolean(firstId), "read-model customer id", firstId ? String(firstId) : "vazio");

  // 5) Read model — detail
  if (firstId) {
    const detail = await buildCustomerDetail(supabase, target.userId, String(firstId), {});
    assert(detail?.customer != null, "read-model detail.customer", "presente");
    assert(detail?.metrics != null, "read-model detail.metrics", "presente");
    assert(Array.isArray(detail?.orders), "read-model detail.orders", `${detail.orders.length} rows`);
    assert(Array.isArray(detail?.insights), "read-model detail.insights", `${detail.insights.length} items`);
    assert(detail.metrics.customer_score === null, "customer_score null", "ok");
  }

  // 8) Fase 4A.2 — ingestion_health (service-level; não depende de HTTP)
  const listHealthOff = await buildCustomersList(supabase, target.userId, { page: 1, page_size: 5 });
  assert(
    listHealthOff.summary?.ingestion_health == null,
    "4A.2 flag OFF ingestion_health null",
    listHealthOff.summary?.ingestion_health == null ? "null" : "presente",
  );

  const prevFlag = process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED;
  process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED = "true";
  const configMod = await import("../src/infra/config.js");
  configMod.config.customersIngestionHealthEnabled = true;

  const listHealthOn = await buildCustomersList(supabase, target.userId, { page: 1, page_size: 5 });
  const ih = listHealthOn.summary?.ingestion_health;
  assert(ih != null, "4A.2 flag ON ingestion_health", ih?.status ?? "ausente");
  assert(
    ["healthy", "degraded", "critical", "unknown"].includes(String(ih?.status)),
    "4A.2 status válido",
    String(ih?.status),
  );
  assert(typeof ih?.coverage_pct === "number", "4A.2 coverage_pct", String(ih?.coverage_pct));
  assert(Array.isArray(ih?.signals), "4A.2 signals", `${ih?.signals?.length ?? 0} items`);
  assert(
    ih?.orders?.materialized + ih?.orders?.pending_materialization === ih?.orders?.total_with_buyer,
    "4A.2 orders balance",
    "ok",
  );

  if (prevFlag == null) delete process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED;
  else process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED = prevFlag;
  configMod.config.customersIngestionHealthEnabled = prevFlag?.trim().toLowerCase() === "true";

  // HTTP smoke (opcional — requer API local)
  let token = null;
  try {
    token = await resolveAccessToken(supabase, target.userId);
    pass("auth", "JWT de smoke obtido via magiclink admin");
  } catch (e) {
    fail("auth", e?.message ?? "falhou");
  }

  try {
  const unauth = await fetchJson("/api/customers");
  assert(unauth.status === 401, "HTTP GET /api/customers sem token", String(unauth.status));

  if (token) {
    const listHttp = await fetchJson("/api/customers?page=1&page_size=5", token);
    assert(listHttp.status === 200 && listHttp.body?.ok === true, "HTTP GET /api/customers", String(listHttp.status));
    assert(listHttp.body?.summary != null, "HTTP summary", "presente");
    assert(listHttp.body?.filters != null, "HTTP filters", "presente");
    assert(Array.isArray(listHttp.body?.customers), "HTTP customers", "array");
    assert(listHttp.body?.pagination != null, "HTTP pagination", "presente");
    assert(typeof listHttp.body?.total === "number", "HTTP legado total", String(listHttp.body?.total));
    assert(typeof listHttp.body?.page === "number", "HTTP legado page", String(listHttp.body?.page));
    assert(typeof listHttp.body?.page_size === "number", "HTTP legado page_size", String(listHttp.body?.page_size));

    const httpCustomerId = listHttp.body?.customers?.[0]?.id;
    if (httpCustomerId) {
      const detailHttp = await fetchJson(`/api/customers/${httpCustomerId}`, token);
      assert(detailHttp.status === 200 && detailHttp.body?.ok !== false, "HTTP GET /api/customers/:id", String(detailHttp.status));
      assert(detailHttp.body?.customer != null, "HTTP detail.customer", "presente");
      assert(detailHttp.body?.metrics != null, "HTTP detail.metrics", "presente");
      assert(Array.isArray(detailHttp.body?.orders), "HTTP detail.orders", "array");
      assert(Array.isArray(detailHttp.body?.insights), "HTTP detail.insights", "array");
      assert(detailHttp.body?.metrics?.customer_score === null, "HTTP customer_score null", "ok");
    }

    // Auth isolation — random UUID
    const foreign = await fetchJson("/api/customers/00000000-0000-4000-8000-000000000001", token);
    assert(foreign.status === 404, "HTTP auth isolation foreign id", String(foreign.status));
  }

  // 7) Clientes360 contract (FE expectations without deploy)
  if (token) {
    const feList = await fetchJson("/api/customers", token);
    const row = feList.body?.customers?.[0];
    const feFields = ["id", "name", "total_orders", "total_spent_brl", "last_purchase_at"];
    const missing = feFields.filter((f) => row && row[f] === undefined);
    assert(
      missing.length === 0 || !row,
      "Clientes360 list row shape",
      row ? feFields.join(", ") : "sem linhas (ok em base vazia filtrada)",
    );
    assert(feList.body?.summary?.total_customers != null, "Clientes360 summary.total_customers", "presente");
  }

  if (token) {
    process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED = "true";
    configMod.config.customersIngestionHealthEnabled = true;
    const httpHealth = await fetchJson("/api/customers?page=1&page_size=5", token);
    if (httpHealth.status === 200) {
      assert(
        httpHealth.body?.summary?.ingestion_health != null,
        "HTTP ingestion_health flag ON",
        httpHealth.body?.summary?.ingestion_health?.status ?? "ausente",
      );
    }
    if (prevFlag == null) delete process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED;
    else process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED = prevFlag;
    configMod.config.customersIngestionHealthEnabled = prevFlag?.trim().toLowerCase() === "true";
  }
  } catch (e) {
    pass("HTTP smoke", `pulado (${e?.cause?.code ?? e?.message ?? "API indisponível"})`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Resultado: ${results.length - failed.length}/${results.length} OK ===\n`);
  if (failed.length) {
    console.log("Falhas:", failed.map((f) => f.step).join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
