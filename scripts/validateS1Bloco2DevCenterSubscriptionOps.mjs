#!/usr/bin/env node
/**
 * S1 Bloco 2 — validação DEV das operações reais de assinatura (Dev Center Toolbox)
 *
 * Uso:
 *   node scripts/validateS1Bloco2DevCenterSubscriptionOps.mjs [--api-base=http://localhost:3001]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });

const apiBase = (
  process.argv.find((a) => a.startsWith("--api-base="))?.split("=")[1] ||
  process.env.SMOKE_API_BASE ||
  "http://localhost:3001"
).replace(/\/$/, "");

const url = (process.env.SUPABASE_URL || "").trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function supabaseProjectRef(supabaseUrl) {
  return supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/i)?.[1] ?? "unknown";
}

const OPERATIONS = [
  "enable_trial",
  "end_trial",
  "add_subscription_days",
  "add_subscription_sales",
  "reset_consumption",
  "recalculate_consumption",
];

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

async function pickAdminUserId(supabase) {
  const { data: admins } = await supabase.from("profiles").select("id").eq("is_admin", true).limit(20);
  if (admins?.length) return admins[0].id;
  const allowRaw = process.env.SUSE7_DEV_CENTER_ALLOWED_EMAILS || "ricardo@suse7.com.br";
  for (const email of allowRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    const hit = (list?.users ?? []).find((u) => String(u.email ?? "").toLowerCase() === email);
    if (hit?.id) return hit.id;
  }
  return null;
}

async function pickSellerWithSubscription(supabase) {
  const { data } = await supabase
    .from("billing_subscriptions")
    .select("user_id, id, status, plan_key")
    .order("updated_at", { ascending: false })
    .limit(50);
  const row = (data ?? []).find((r) => r.user_id);
  return row ? { sellerId: String(row.user_id), subscriptionId: String(row.id) } : null;
}

async function fetchJson(route, token, opts = {}) {
  const started = Date.now();
  const res = await fetch(`${apiBase}${route}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - started };
}

async function postOperation(token, sellerId, actionId, reason) {
  return fetchJson(`/api/dev-center/sellers/${sellerId}/subscription/operations`, token, {
    method: "POST",
    body: { actionId, reason },
  });
}

async function main() {
  console.log("\n=== S1 Bloco 2 — Validação operações assinatura (DEV) ===\n");
  console.log("API base:", apiBase);
  console.log("Supabase script:", {
    url_ref: supabaseProjectRef(url),
    schema: "public",
    service_role: serviceKey ? "definido" : "AUSENTE",
  });

  if (!url || !serviceKey) {
    fail("setup", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const supabaseDb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const auditProbe = await supabaseDb.from("dev_center_toolbox_operational_audit").select("id").limit(1);
  assert(!auditProbe.error, "migration", "tabela dev_center_toolbox_operational_audit acessível");

  const auditBeforeAll = await supabaseDb
    .from("dev_center_toolbox_operational_audit")
    .select("id, operation_type, status, seller_id, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  assert(!auditBeforeAll.error, "audit:baseline", "SELECT sem filtro (service role) OK");
  pass("audit:baseline", `${auditBeforeAll.data?.length ?? 0} registros visíveis antes das ops`);

  const sellerCtx = await pickSellerWithSubscription(supabaseDb);
  assert(Boolean(sellerCtx?.sellerId), "setup", "seller com assinatura", sellerCtx?.sellerId?.slice(0, 8) + "…");
  if (!sellerCtx) process.exit(1);

  const adminUserId = await pickAdminUserId(supabaseDb);
  assert(Boolean(adminUserId), "setup", "admin user resolvido");
  if (!adminUserId) process.exit(1);

  let adminToken;
  try {
    adminToken = await resolveAccessToken(supabase, adminUserId);
    pass("setup", "JWT admin obtido");
  } catch (e) {
    fail("setup", `JWT admin: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const health = await fetch(`${apiBase}/api/dev-center/bootstrap`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  }).catch(() => null);
  assert(health?.ok === true, "setup", "backend DEV acessível", apiBase);

  const sellerId = sellerCtx.sellerId;
  const reasonBase = "Validação operacional S1 Bloco 2 — teste automatizado DEV";

  const detailBefore = await fetchJson(`/api/dev-center/sellers/${sellerId}`, adminToken);
  assert(detailBefore.status === 200 && detailBefore.body?.ok === true, "reload", "GET seller detail antes das ops");

  /** @type {string[]} */
  const auditIds = [];

  for (const actionId of OPERATIONS) {
    const res = await postOperation(adminToken, sellerId, actionId, `${reasonBase} — ${actionId}`);
    assert(res.status === 200 && res.body?.ok === true, `op:${actionId}`, `status=${res.status} audit=${res.body?.auditId ?? "?"}`);
    assert(Boolean(res.body?.auditId), `auditId:${actionId}`, "auditId presente na resposta");
    if (res.body?.auditId) auditIds.push(String(res.body.auditId));
  }

  const forceErr = await postOperation(
    adminToken,
    sellerId,
    "enable_trial",
    `${reasonBase} — [DEV:FORCE_ERROR] simulação de falha`,
  );
  assert(forceErr.status >= 400, "op:force_error", `HTTP ${forceErr.status} code=${forceErr.body?.code ?? "?"}`);
  if (forceErr.body?.auditId) auditIds.push(String(forceErr.body.auditId));

  for (const auditId of auditIds) {
    const { data: row, error: rowErr } = await supabaseDb
      .from("dev_center_toolbox_operational_audit")
      .select("id, seller_id, operation_type, status, created_at")
      .eq("id", auditId)
      .maybeSingle();
    assert(!rowErr && row?.id === auditId, `audit:persist:${auditId.slice(0, 8)}`, row?.operation_type ?? rowErr?.message ?? "missing");
  }

  const detailAfter = await fetchJson(`/api/dev-center/sellers/${sellerId}`, adminToken);
  assert(detailAfter.status === 200, "reload", "GET seller detail após ops");
  assert(detailAfter.body?.subscription != null, "reload", "bloco subscription presente");
  assert(
    detailAfter.body?.subscription?.usage != null ||
      detailAfter.body?.subscription?.usage_current != null,
    "reload",
    "usage real no seller detail",
  );

  const { data: auditRows, error: auditErr } = await supabaseDb
    .from("dev_center_toolbox_operational_audit")
    .select("id, seller_id, operation_type, status, operator_user_id, created_at")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(30);

  assert(!auditErr, "audit:query", auditErr?.message ?? "query ok");

  const { data: auditAll, error: auditAllErr } = await supabaseDb
    .from("dev_center_toolbox_operational_audit")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(20);
  assert(!auditAllErr, "audit:unfiltered", `${auditAll?.length ?? 0} registros (sem filtro)`);

  assert(Array.isArray(auditRows) && auditRows.length >= OPERATIONS.length, "audit", `${auditRows?.length ?? 0} registros recentes`);
  const successOps = new Set(
    (auditRows ?? []).filter((r) => r.status === "success").map((r) => String(r.operation_type)),
  );
  for (const actionId of OPERATIONS) {
    assert(successOps.has(actionId), "audit", `registro success para ${actionId}`);
  }

  const errorAudit = (auditRows ?? []).find((r) => r.status === "error" && String(r.operation_type) === "enable_trial");
  assert(Boolean(errorAudit), "audit", "registro error para [DEV:FORCE_ERROR]");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n--- Resultado: ${results.length - failed.length}/${results.length} OK ---\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
