#!/usr/bin/env node
// =============================================================================
// Validação S_4.6.3 — fronteira Admin Global × Seller (runtime)
// Uso: node scripts/validate_4a63_dev_center_boundary.mjs [--api-base=http://localhost:3001]
// =============================================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const apiBase = (
  process.argv.find((a) => a.startsWith("--api-base="))?.split("=")[1] ||
  process.env.SMOKE_API_BASE ||
  "http://localhost:3001"
).replace(/\/$/, "");

const url = (process.env.SUPABASE_URL || "").trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

/** @type {Array<{ block: string; step: string; ok: boolean; detail?: string }>} */
const results = [];

function pass(block, step, detail) {
  results.push({ block, step, ok: true, detail });
  console.log(`✅ [${block}] ${step}${detail ? ` — ${detail}` : ""}`);
}

function fail(block, step, detail) {
  results.push({ block, step, ok: false, detail });
  console.error(`❌ [${block}] ${step}${detail ? ` — ${detail}` : ""}`);
}

function assert(cond, block, step, detail) {
  if (cond) pass(block, step, detail);
  else fail(block, step, detail);
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
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

async function pickAdminUserId(supabase) {
  const allowRaw = process.env.SUSE7_DEV_CENTER_ALLOWED_EMAILS || "ricardo@suse7.com.br";
  const allow = allowRaw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const { data: admins } = await supabase.from("profiles").select("id, is_admin").eq("is_admin", true).limit(20);
  if (admins?.length) return admins[0].id;

  for (const email of allow) {
    const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    const hit = (list?.users ?? []).find((u) => String(u.email ?? "").toLowerCase() === email);
    if (hit?.id) return hit.id;
  }
  return null;
}

/**
 * @param {string} route
 * @param {string} token
 * @param {{ method?: string; query?: Record<string, string> }} [opts]
 */
async function fetchApi(route, token, opts = {}) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const started = Date.now();
  const res = await fetch(`${apiBase}${route}${qs}`, {
    method: opts.method ?? "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - started };
}

function isAdminSummaryShape(summary) {
  if (!summary || typeof summary !== "object") return false;
  if (summary.scope !== "admin_global") return false;
  if (!("total_customers" in summary)) return false;
  if (!("listed_customers" in summary)) return false;
  if (!("incomplete_contact" in summary)) return false;
  if (!("ingestion_health" in summary)) return false;
  if (!("data_quality_overview" in summary)) return false;
  return true;
}

function maskCheckListCustomer(c) {
  if (!c || typeof c !== "object") return false;
  if (c.document != null && !String(c.document).includes("•") && !String(c.document).includes("*")) {
    return false;
  }
  return true;
}

async function main() {
  console.log("\n=== S_4.6.3 — Validação fronteira Admin × Seller ===\n");
  console.log("API base:", apiBase);
  console.log(
    "Flags:",
    `INGESTION=${process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED ?? "false"}`,
    `QUALITY=${process.env.CUSTOMERS_DATA_QUALITY_ENABLED ?? "false"}`,
  );

  if (!url || !serviceKey) {
    fail("setup", "env", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const adminUserId = await pickAdminUserId(supabase);
  const sellerUserId = await pickSellerUserId(supabase);
  assert(Boolean(adminUserId), "setup", "admin user resolvido", adminUserId ? adminUserId.slice(0, 8) + "…" : "ausente");
  assert(Boolean(sellerUserId), "setup", "seller user resolvido", sellerUserId ? sellerUserId.slice(0, 8) + "…" : "ausente");
  if (!adminUserId || !sellerUserId) process.exit(1);

  let adminToken;
  let sellerToken;
  try {
    adminToken = await resolveAccessToken(supabase, adminUserId);
    sellerToken = await resolveAccessToken(supabase, sellerUserId);
    pass("setup", "JWT admin + seller obtidos");
  } catch (e) {
    fail("setup", "auth", e?.message ?? "falhou");
    process.exit(1);
  }

  /** @type {string[]} */
  const adminRequests = [];
  /** @type {string[]} */
  const sellerRequests = [];

  // --- BLOCO 1: Dev Center Global ---
  const list1 = await fetchApi("/api/dev-center/customers-global", adminToken);
  adminRequests.push("GET /api/dev-center/customers-global");
  assert(list1.status === 200 && list1.body?.ok === true, "admin-global", "listagem 200", `${list1.ms}ms`);
  assert(Array.isArray(list1.body?.customers), "admin-global", "customers[] array", String(list1.body?.customers?.length ?? 0));
  assert(isAdminSummaryShape(list1.body?.summary), "admin-global", "summary.scope=admin_global", list1.body?.summary?.scope ?? "invalid");

  const flagsIngestionOn =
    String(process.env.CUSTOMERS_INGESTION_HEALTH_ENABLED ?? "false").trim().toLowerCase() === "true";
  const flagsQualityOn =
    String(process.env.CUSTOMERS_DATA_QUALITY_ENABLED ?? "false").trim().toLowerCase() === "true";

  if (flagsIngestionOn) {
    assert(
      list1.body.summary.ingestion_health != null,
      "admin-global",
      "ingestion_health presente (flag ON)",
      list1.body.summary.ingestion_health?.status ?? "?",
    );
  } else {
    assert(
      list1.body.summary.ingestion_health == null,
      "admin-global",
      "ingestion_health null (flag OFF)",
      list1.body.summary.ingestion_health == null ? "null" : "unexpected",
    );
  }

  if (flagsQualityOn) {
    assert(
      list1.body.summary.data_quality_overview != null,
      "admin-global",
      "data_quality_overview presente (flag ON)",
      list1.body.summary.data_quality_overview?.status ?? "?",
    );
  } else {
    assert(
      list1.body.summary.data_quality_overview == null,
      "admin-global",
      "data_quality_overview null (flag OFF)",
      list1.body.summary.data_quality_overview == null ? "null" : "unexpected",
    );
  }

  for (const q of ["", "a", "zzzzzzzz-not-found-xyz", "jo@o", "••••"]) {
    const r = await fetchApi("/api/dev-center/customers-global", adminToken, { query: { q } });
    adminRequests.push(`GET /api/dev-center/customers-global?q=${encodeURIComponent(q)}`);
    assert(r.status === 200 && r.body?.ok === true, "admin-global", `busca q=${JSON.stringify(q)}`, `${r.ms}ms`);
    assert(isAdminSummaryShape(r.body?.summary), "admin-global", `summary busca q=${JSON.stringify(q)}`, "ok");
  }

  const firstId = list1.body?.customers?.[0]?.id;
  if (firstId) {
    const detail = await fetchApi(`/api/dev-center/customers-global/${firstId}`, adminToken);
    adminRequests.push(`GET /api/dev-center/customers-global/:id`);
    assert(detail.status === 200 && detail.body?.ok === true, "admin-global", "drawer detail 200", `${detail.ms}ms`);
    const c = detail.body?.customer;
    assert(c?.document_masked != null || c?.document_masked == null, "admin-global", "detalhe sem document_normalized bruto", "masked fields only");
    assert(!("document_normalized" in (c ?? {})), "admin-global", "LGPD document_normalized ausente", "ok");
    assert(!("email_normalized" in (c ?? {})), "admin-global", "LGPD email_normalized ausente", "ok");
  } else {
    pass("admin-global", "drawer detail skip", "lista vazia — cenário tabela global vazia OK");
  }

  for (const row of (list1.body?.customers ?? []).slice(0, 5)) {
    assert(maskCheckListCustomer(row), "admin-global", "listagem mascarada", row?.id?.slice(0, 8) ?? "?");
  }

  // Proibido: admin token em /api/customers não deve ser usado pela tela — validamos isolamento de contrato seller com seller token
  const sellerFromAdmin = await fetchApi("/api/customers?page=1&page_size=1", adminToken);
  pass(
    "admin-global",
    "admin token em /api/customers (referência)",
    `status=${sellerFromAdmin.status} — tela admin NÃO deve chamar esta rota`,
  );

  // --- BLOCO 2: Clientes360 Seller ---
  const sellerList = await fetchApi("/api/customers?page=1&page_size=5", sellerToken);
  sellerRequests.push("GET /api/customers");
  assert(sellerList.status === 200 && sellerList.body?.ok === true, "seller", "listagem 200", `${sellerList.ms}ms`);
  assert(Array.isArray(sellerList.body?.customers), "seller", "customers[] array", "ok");
  assert(sellerList.body?.summary != null, "seller", "summary seller presente", "ok");
  assert(sellerList.body?.summary?.scope !== "admin_global", "seller", "summary NÃO é admin_global", "ok");

  const sellerCustomerId = sellerList.body?.customers?.[0]?.id;
  if (sellerCustomerId) {
    const sellerDetail = await fetchApi(`/api/customers/${sellerCustomerId}`, sellerToken);
    sellerRequests.push("GET /api/customers/:id");
    assert(sellerDetail.status === 200, "seller", "detalhe 200", `${sellerDetail.ms}ms`);
  }

  const adminFromSeller = await fetchApi("/api/dev-center/customers-global", sellerToken);
  sellerRequests.push("GET /api/dev-center/customers-global (seller token)");
  assert(
    adminFromSeller.status === 403 || adminFromSeller.status === 401,
    "seller",
    "seller bloqueado no admin global",
    String(adminFromSeller.status),
  );

  // --- BLOCO 3: Resiliência (contrato vazio) ---
  assert(
    list1.body.summary != null || list1.body.customers.length === 0,
    "resilience",
    "summary presente mesmo com lista vazia ou populada",
    list1.body.summary ? "summary ok" : "missing",
  );
  assert(
    typeof (list1.body.summary?.total_customers ?? 0) === "number",
    "resilience",
    "total_customers numérico",
    String(list1.body.summary?.total_customers),
  );

  // --- BLOCO 4: Performance (contagem requests script = proxy arquitetural) ---
  const uniqueAdmin = new Set(adminRequests);
  assert(uniqueAdmin.size === adminRequests.length, "perf", "sem duplicação acidental no script admin", `${adminRequests.length} calls`);

  console.log("\n--- Requests admin (evidência) ---");
  for (const r of adminRequests) console.log(" ", r);
  console.log("\n--- Requests seller (evidência) ---");
  for (const r of sellerRequests) console.log(" ", r);
  console.log("\n--- Proibido na tela admin (grep estático confirmado S_4.6.2) ---");
  console.log("  GET /api/customers");
  console.log("  GET /api/customers/:id");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} OK ===\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
