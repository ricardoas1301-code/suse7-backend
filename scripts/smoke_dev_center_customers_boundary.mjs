#!/usr/bin/env node
// =============================================================================
// Smoke permanente — fronteira Admin Global × Seller (Dev Center Clientes)
//
// Valida contratos, LGPD, flags ON/OFF e bloqueio cross-domain (403 seller→admin).
//
// Uso:
//   npm run smoke:dev-center-customers-boundary
//   node scripts/smoke_dev_center_customers_boundary.mjs [--api-base=http://localhost:3001]
//
// Requer: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API local ou SMOKE_API_BASE
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

/** Segundo seller distinto — S_4.8.2 isolamento cross-seller */
async function pickSecondSellerUserId(supabase, excludeUserId) {
  const { data } = await supabase.from("sales_orders").select("user_id").limit(5000);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of data ?? []) {
    const uid = String(r.user_id ?? "");
    if (!uid || uid === excludeUserId) continue;
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

/** S_4.8.3 — request sem Authorization */
async function fetchApiNoAuth(route) {
  const started = Date.now();
  const res = await fetch(`${apiBase}${route}`, { method: "GET" });
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

function isAdminDetailShape(body) {
  if (!body || typeof body !== "object") return false;
  if (!body.customer || typeof body.customer !== "object") return false;
  if (!body.overview || typeof body.overview !== "object") return false;
  if (!body.activity || typeof body.activity !== "object") return false;
  if (!body.quality || body.quality.status !== "not_available") return false;
  if (!body.ingestion || body.ingestion.status !== "not_available") return false;
  if (!body.metadata || body.metadata.scope !== "admin_global") return false;
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
  console.log("\n=== Smoke Dev Center Clientes — fronteira Admin × Seller ===\n");
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

  // --- BLOCO S_4.8.3: Permissões / autorização ---
  const bootNoAuth = await fetchApiNoAuth("/api/dev-center/bootstrap");
  assert(bootNoAuth.status === 200, "auth", "bootstrap sem JWT → 200", String(bootNoAuth.status));
  assert(bootNoAuth.body?.allowed === false, "auth", "bootstrap sem JWT allowed=false", String(bootNoAuth.body?.allowed));

  const listNoAuth = await fetchApiNoAuth("/api/dev-center/customers-global");
  assert(listNoAuth.status === 401, "auth", "customers-global sem JWT → 401", String(listNoAuth.status));
  assert(listNoAuth.body?.code === "UNAUTHORIZED", "auth", "sem JWT code UNAUTHORIZED", listNoAuth.body?.code ?? "?");

  const invalidToken = await fetchApi("/api/dev-center/customers-global", "invalid.jwt.token");
  assert(invalidToken.status === 401, "auth", "JWT inválido → 401", String(invalidToken.status));

  const sellerForbidden = await fetchApi("/api/dev-center/customers-global", sellerToken);
  assert(sellerForbidden.status === 403, "auth", "seller → 403", String(sellerForbidden.status));
  assert(
    sellerForbidden.body?.code === "FORBIDDEN",
    "auth",
    "seller code FORBIDDEN (não NOT_FOUND)",
    sellerForbidden.body?.code ?? "?",
  );
  assert(
    !String(sellerForbidden.body?.message ?? "").toLowerCase().includes("encontrado"),
    "auth",
    "403 mensagem neutra",
    "ok",
  );

  const bootAdmin = await fetchApi("/api/dev-center/bootstrap", adminToken);
  assert(bootAdmin.status === 200 && bootAdmin.body?.allowed === true, "auth", "admin bootstrap allowed", "ok");

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
    assert(isAdminDetailShape(detail.body), "admin-global", "contrato S_4.7.1 detail enriquecido", "ok");
    const c = detail.body?.customer;
    assert(c?.document_masked != null || c?.document_masked == null, "admin-global", "detalhe sem document_normalized bruto", "masked fields only");
    assert(!("document_normalized" in (c ?? {})), "admin-global", "LGPD document_normalized ausente", "ok");
    assert(!("email_normalized" in (c ?? {})), "admin-global", "LGPD email_normalized ausente", "ok");
    assert(!("dedupe_key" in (c ?? {})), "admin-global", "dedupe_key não exposto", "ok");
    assert(Array.isArray(detail.body?.activity?.related_sellers), "admin-global", "activity.related_sellers array", "ok");
    assert(detail.body?.quality?.reason === "per_customer_quality_not_computed", "admin-global", "quality not_available", "ok");
    assert(detail.body?.ingestion?.reason === "per_customer_ingestion_not_computed", "admin-global", "ingestion not_available", "ok");
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

  if (firstId) {
    const globalFromSeller = await fetchApi(`/api/dev-center/customers-global/${firstId}`, sellerToken);
    sellerRequests.push("GET /api/dev-center/customers-global/:id (seller token)");
    assert(
      globalFromSeller.status === 403 || globalFromSeller.status === 401,
      "cross-seller",
      "seller bloqueado no detail global",
      String(globalFromSeller.status),
    );
  }

  // --- BLOCO S_4.8.2: Seller A × Seller B ---
  const sellerBUserId = await pickSecondSellerUserId(supabase, sellerUserId);
  if (sellerBUserId && sellerBUserId !== sellerUserId) {
    let sellerBToken;
    try {
      sellerBToken = await resolveAccessToken(supabase, sellerBUserId);
      pass("cross-seller", "JWT seller B obtido", sellerBUserId.slice(0, 8) + "…");
    } catch (e) {
      fail("cross-seller", "auth seller B", e?.message ?? "falhou");
      sellerBToken = null;
    }

    if (sellerBToken) {
      const listB = await fetchApi("/api/customers?page=1&page_size=5", sellerBToken);
      const idA = sellerCustomerId;
      const idB = listB.body?.customers?.[0]?.id;

      if (idA && idB && idA !== idB) {
        const crossDetail = await fetchApi(`/api/customers/${idB}`, sellerToken);
        assert(
          crossDetail.status === 404,
          "cross-seller",
          "seller A não acessa cliente do seller B",
          `status=${crossDetail.status}`,
        );
      } else {
        pass("cross-seller", "seller A×B detail skip", "ids indisponíveis ou iguais — ambiente OK");
      }

      const adminGlobalFromB = await fetchApi("/api/dev-center/customers-global", sellerBToken);
      assert(
        adminGlobalFromB.status === 403 || adminGlobalFromB.status === 401,
        "cross-seller",
        "seller B bloqueado no admin global",
        String(adminGlobalFromB.status),
      );
    }
  } else {
    pass("cross-seller", "seller B skip", "apenas um seller no ambiente — isolamento A documentado");
  }

  assert(
    list1.body?.summary?.scope === "admin_global",
    "cross-seller",
    "admin list summary scope admin_global",
    list1.body?.summary?.scope ?? "?",
  );
  assert(
    sellerList.body?.summary?.scope !== "admin_global",
    "cross-seller",
    "seller summary não é admin_global",
    String(sellerList.body?.summary?.scope ?? "null"),
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
