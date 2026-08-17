#!/usr/bin/env node
/**
 * S1 Bloco 3 — validação DEV feature flags + integrações (Dev Center Toolbox)
 *
 * Uso:
 *   node scripts/validateS1Bloco3DevCenterToolboxOps.mjs [--api-base=http://localhost:3001]
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

const FEATURE_FLAG_OPS = ["enable_feature_flag", "disable_feature_flag"];
const INTEGRATION_OPS = [
  "validate_marketplace_token",
  "refresh_integration_health",
  "force_marketplace_sync",
  "invalidate_integration_cache",
  "reimport_marketplace_account",
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

async function pickAdminUserId(supabaseDb) {
  const { data: admins } = await supabaseDb.from("profiles").select("id").eq("is_admin", true).limit(20);
  if (admins?.length) return admins[0].id;
  const allowRaw = process.env.SUSE7_DEV_CENTER_ALLOWED_EMAILS || "ricardo@suse7.com.br";
  for (const email of allowRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    const hit = (list?.users ?? []).find((u) => String(u.email ?? "").toLowerCase() === email);
    if (hit?.id) return hit.id;
  }
  return null;
}

async function pickSellerWithMarketplaceAccount(supabaseDb) {
  const { data } = await supabaseDb
    .from("marketplace_accounts")
    .select("id, user_id, marketplace")
    .order("updated_at", { ascending: false })
    .limit(50);
  const row = (data ?? []).find((r) => r.user_id && r.id);
  return row
    ? {
        sellerId: String(row.user_id),
        accountId: String(row.id),
        marketplace: row.marketplace != null ? String(row.marketplace) : null,
      }
    : null;
}

async function fetchJson(route, token, opts = {}) {
  const res = await fetch(`${apiBase}${route}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postFeatureFlagOp(token, sellerId, actionId, reason, metadata) {
  return fetchJson(`/api/dev-center/sellers/${sellerId}/feature-flags/operations`, token, {
    method: "POST",
    body: { actionId, reason, metadata },
  });
}

async function postIntegrationOp(token, sellerId, actionId, reason, metadata) {
  return fetchJson(`/api/dev-center/sellers/${sellerId}/integrations/operations`, token, {
    method: "POST",
    body: { actionId, reason, metadata },
  });
}

async function main() {
  console.log("\n=== S1 Bloco 3 — Validação feature flags + integrações (DEV) ===\n");
  console.log("API base:", apiBase);

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

  const flagsProbe = await supabaseDb.from("dev_center_seller_feature_flags").select("id").limit(1);
  assert(!flagsProbe.error, "migration:feature_flags", "tabela dev_center_seller_feature_flags acessível");

  const auditCols = await supabaseDb
    .from("dev_center_toolbox_operational_audit")
    .select("id, marketplace_account_id")
    .limit(1);
  assert(!auditCols.error, "migration:audit_account", "coluna marketplace_account_id acessível");

  const ctx = await pickSellerWithMarketplaceAccount(supabaseDb);
  assert(Boolean(ctx?.sellerId && ctx?.accountId), "setup", "seller + conta marketplace", ctx?.sellerId?.slice(0, 8));
  if (!ctx) process.exit(1);

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
  assert(health?.ok === true, "setup", "backend DEV acessível");

  const sellerId = ctx.sellerId;
  const accountId = ctx.accountId;
  const reasonBase = "Validação operacional S1 Bloco 3 — teste automatizado DEV";
  const flagKey = "advanced_dashboard";

  /** @type {string[]} */
  const auditIds = [];

  const detailBefore = await fetchJson(`/api/dev-center/sellers/${sellerId}`, adminToken);
  assert(detailBefore.status === 200 && detailBefore.body?.ok === true, "reload", "GET seller detail antes");

  for (const actionId of FEATURE_FLAG_OPS) {
    const res = await postFeatureFlagOp(adminToken, sellerId, actionId, `${reasonBase} — ${actionId}`, {
      flagKey,
      flagLabel: "Dashboard avançado",
    });
    assert(res.status === 200 && res.body?.ok === true, `flag:${actionId}`, `audit=${res.body?.auditId ?? "?"}`);
    assert(Boolean(res.body?.auditId), `flag:auditId:${actionId}`, "auditId presente");
    if (res.body?.auditId) auditIds.push(String(res.body.auditId));
  }

  const detailFlags = await fetchJson(`/api/dev-center/sellers/${sellerId}`, adminToken);
  assert(Array.isArray(detailFlags.body?.feature_flags), "reload", "feature_flags no seller detail");
  const flagRow = (detailFlags.body?.feature_flags ?? []).find((f) => f.key === flagKey);
  assert(flagRow != null, "reload", `flag ${flagKey} catalogada`);

  for (const actionId of INTEGRATION_OPS) {
    const res = await postIntegrationOp(adminToken, sellerId, actionId, `${reasonBase} — ${actionId}`, {
      accountId,
      marketplace: ctx.marketplace,
    });
    assert(
      res.status === 200 && res.body?.ok === true,
      `integration:${actionId}`,
      `audit=${res.body?.auditId ?? "?"} account=${res.body?.marketplaceAccountId ?? "?"}`,
    );
    assert(Boolean(res.body?.auditId), `integration:auditId:${actionId}`, "auditId presente");
    if (res.body?.auditId) auditIds.push(String(res.body.auditId));
  }

  const forceErr = await postIntegrationOp(
    adminToken,
    sellerId,
    "validate_marketplace_token",
    `${reasonBase} — [DEV:FORCE_ERROR] simulação`,
    { accountId },
  );
  assert(forceErr.status >= 400, "integration:force_error", `HTTP ${forceErr.status}`);
  if (forceErr.body?.auditId) auditIds.push(String(forceErr.body.auditId));

  for (const auditId of auditIds) {
    const { data: row, error: rowErr } = await supabaseDb
      .from("dev_center_toolbox_operational_audit")
      .select("id, seller_id, marketplace_account_id, operation_type, status")
      .eq("id", auditId)
      .maybeSingle();
    assert(!rowErr && row?.id === auditId, `audit:persist:${auditId.slice(0, 8)}`, row?.operation_type ?? "missing");
  }

  const integrationAudit = await supabaseDb
    .from("dev_center_toolbox_operational_audit")
    .select("marketplace_account_id, operation_type")
    .eq("seller_id", sellerId)
    .in("operation_type", INTEGRATION_OPS)
    .not("marketplace_account_id", "is", null)
    .limit(10);
  assert(
    (integrationAudit.data ?? []).length >= 3,
    "audit:marketplace_account_id",
    `${integrationAudit.data?.length ?? 0} registros com account_id`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n--- Resultado: ${results.length - failed.length}/${results.length} OK ---\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
