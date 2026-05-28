#!/usr/bin/env node
/**
 * S1 Bloco 4 — validação auditoria estruturada + timeline operacional
 *
 * Uso:
 *   node scripts/validateS1Bloco4DevCenterOperationalAudit.mjs [--api-base=http://localhost:3001]
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
  return null;
}

async function pickSellerWithSubscription(supabaseDb) {
  const { data } = await supabaseDb
    .from("billing_subscriptions")
    .select("user_id, id")
    .order("updated_at", { ascending: false })
    .limit(20);
  const row = (data ?? []).find((r) => r.user_id);
  return row ? { sellerId: String(row.user_id), subscriptionId: String(row.id) } : null;
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

async function main() {
  console.log("\n=== S1 Bloco 4 — Validação auditoria estruturada + timeline ===\n");

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

  const colsProbe = await supabaseDb
    .from("dev_center_toolbox_operational_audit")
    .select("id, before_state, after_state, changed_fields, entity_type, entity_id, category")
    .limit(1);
  assert(!colsProbe.error, "migration:structured_columns", "colunas before/after acessíveis");

  const ctx = await pickSellerWithSubscription(supabaseDb);
  assert(Boolean(ctx?.sellerId), "setup", "seller com assinatura", ctx?.sellerId?.slice(0, 8));
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

  const sellerId = ctx.sellerId;
  const reason = "Validação operacional S1 Bloco 4 — teste automatizado DEV";

  const { data: flagRow } = await supabaseDb
    .from("dev_center_seller_feature_flags")
    .select("enabled")
    .eq("seller_id", sellerId)
    .eq("flag_key", "advanced_dashboard")
    .maybeSingle();

  const actionId = flagRow?.enabled === true ? "disable_feature_flag" : "enable_feature_flag";

  const flagRes = await fetchJson(
    `/api/dev-center/sellers/${sellerId}/feature-flags/operations`,
    adminToken,
    {
      method: "POST",
      body: {
        actionId,
        reason,
        metadata: { flagKey: "advanced_dashboard", flagLabel: "Dashboard avançado" },
      },
    },
  );
  assert(flagRes.status === 200 && flagRes.body?.ok === true, `op:${actionId}`, `audit=${flagRes.body?.auditId ?? "?"}`);

  const auditId = flagRes.body?.auditId ? String(flagRes.body.auditId) : null;
  assert(Boolean(auditId), "auditId", "presente na resposta");

  if (auditId) {
    const { data: row, error } = await supabaseDb
      .from("dev_center_toolbox_operational_audit")
      .select(
        "id, operation_type, status, operator_user_id, operator_email, before_state, after_state, changed_fields, entity_type, entity_id, category, payload, created_at",
      )
      .eq("id", auditId)
      .maybeSingle();

    assert(!error && row?.id === auditId, "audit:persist", row?.operation_type ?? "missing");
    assert(row?.category === "feature_flag", "audit:category", String(row?.category));
    assert(row?.entity_type === "feature_flag", "audit:entity_type", String(row?.entity_type));
    assert(Array.isArray(row?.changed_fields) && row.changed_fields.length > 0, "audit:changed_fields", `${row?.changed_fields?.length ?? 0} campos`);
    assert(row?.before_state && typeof row.before_state === "object", "audit:before_state", "objeto persistido");
    assert(row?.after_state && typeof row.after_state === "object", "audit:after_state", "objeto persistido");
    assert(Boolean(row?.operator_user_id), "audit:operator", "operador registrado");
    assert(Boolean(row?.created_at), "audit:timestamp", "timestamp registrado");
    assert(row?.payload && typeof row.payload === "object", "audit:payload", "payload registrado");
  }

  const timelineRes = await fetchJson(
    `/api/dev-center/sellers/${sellerId}/operational-timeline?limit=20`,
    adminToken,
  );
  assert(timelineRes.status === 200 && timelineRes.body?.ok === true, "timeline:endpoint", "GET operational-timeline");
  assert(Array.isArray(timelineRes.body?.timeline?.events), "timeline:events", `${timelineRes.body?.timeline?.events?.length ?? 0} eventos`);

  const historyRes = await fetchJson(
    `/api/dev-center/sellers/${sellerId}/operational-history?limit=20`,
    adminToken,
  );
  assert(historyRes.status === 200 && historyRes.body?.ok === true, "history:endpoint", "GET operational-history");
  assert(Array.isArray(historyRes.body?.history?.entries), "history:entries", `${historyRes.body?.history?.entries?.length ?? 0} entradas`);

  const latestEvent = timelineRes.body?.timeline?.events?.[0];
  if (latestEvent) {
    assert(Boolean(latestEvent.eventId), "timeline:eventId", latestEvent.eventId.slice(0, 8));
    assert(Boolean(latestEvent.eventLabel), "timeline:eventLabel", latestEvent.eventLabel);
    assert(Boolean(latestEvent.adminEmail || latestEvent.adminName), "timeline:operator", "operador na timeline");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n--- Resultado: ${results.length - failed.length}/${results.length} OK ---\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
