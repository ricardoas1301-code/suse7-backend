#!/usr/bin/env node
/**
 * S_4.8.4 — Smoke hardening (inputs negativos + resiliência HTTP)
 * npm run smoke:dev-center-customers-hardening
 */
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

/** @type {string[]} */
const failures = [];

function assert(name, cond, detail = "") {
  if (cond) console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures.push(name);
    console.error(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function resolveAccessToken(supabase, userId) {
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) throw new Error(userErr?.message || "user");
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) throw new Error(linkErr?.message || "link");
  const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpErr || !otpData?.session?.access_token) throw new Error(otpErr?.message || "otp");
  return otpData.session.access_token;
}

async function pickAdminUserId(supabase) {
  const { data: admins } = await supabase.from("profiles").select("id").eq("is_admin", true).limit(1);
  return admins?.[0]?.id ?? null;
}

async function pickSellerUserId(supabase) {
  const { data } = await supabase.from("sales_orders").select("user_id").limit(100);
  return data?.[0]?.user_id ?? null;
}

async function fetchApi(route, token, opts = {}) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const headers = token != null ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${apiBase}${route}${qs}`, { method: "GET", headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log("\n=== Smoke Hardening S_4.8.4 ===\n");
  if (!url || !serviceKey) {
    console.error("Missing SUPABASE env");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const adminId = await pickAdminUserId(supabase);
  const sellerId = await pickSellerUserId(supabase);
  if (!adminId || !sellerId) {
    console.error("admin/seller not found");
    process.exit(1);
  }

  const adminToken = await resolveAccessToken(supabase, adminId);
  const sellerToken = await resolveAccessToken(supabase, sellerId);

  const noJwt = await fetchApi("/api/dev-center/customers-global", null);
  assert("sem JWT → 401", noJwt.status === 401, String(noJwt.status));

  const badJwt = await fetchApi("/api/dev-center/customers-global", "not.valid.jwt");
  assert("JWT inválido → 401", badJwt.status === 401, String(badJwt.status));

  const sellerBlock = await fetchApi("/api/dev-center/customers-global", sellerToken);
  assert("seller → 403", sellerBlock.status === 403, sellerBlock.body?.code ?? "");

  const emptyQ = await fetchApi("/api/dev-center/customers-global", adminToken, { query: { q: "" } });
  assert("q vazia → 200", emptyQ.status === 200 && emptyQ.body?.ok === true, String(emptyQ.status));

  const hugeQ = await fetchApi("/api/dev-center/customers-global", adminToken, {
    query: { q: "z".repeat(500) },
  });
  assert("q gigante → 200", hugeQ.status === 200 && hugeQ.body?.ok === true, String(hugeQ.status));

  const unicodeQ = await fetchApi("/api/dev-center/customers-global", adminToken, {
    query: { q: "ação café" },
  });
  assert("q unicode → 200", unicodeQ.status === 200, String(unicodeQ.status));

  const specialQ = await fetchApi("/api/dev-center/customers-global", adminToken, {
    query: { q: "  jo@o  + % ••••  " },
  });
  assert("q special → 200", specialQ.status === 200, String(specialQ.status));

  const malformed = await fetchApi("/api/dev-center/customers-global/not-a-valid-id", adminToken);
  assert("id malformado → 404", malformed.status === 404, malformed.body?.code ?? "");

  const longId = await fetchApi(
    `/api/dev-center/customers-global/${"a".repeat(200)}`,
    adminToken,
  );
  assert("id longo → 404", longId.status === 404, String(longId.status));

  const missingUuid = "00000000-0000-4000-8000-000000000000";
  const notFound = await fetchApi(`/api/dev-center/customers-global/${missingUuid}`, adminToken);
  assert("id UUID inexistente → 404", notFound.status === 404, notFound.body?.code ?? "");

  const okList = await fetchApi("/api/dev-center/customers-global", adminToken);
  assert("admin list → 200", okList.status === 200, String(okList.status));
  assert("customers array", Array.isArray(okList.body?.customers), "ok");
  assert("summary present", okList.body?.summary?.scope === "admin_global", okList.body?.summary?.scope);

  if (okList.body?.customers?.[0]?.id) {
    const detail = await fetchApi(
      `/api/dev-center/customers-global/${okList.body.customers[0].id}`,
      adminToken,
    );
    assert("detail ok → 200", detail.status === 200 && detail.body?.metadata?.scope === "admin_global", "");
  }

  console.log(`\n=== ${failures.length ? "FAIL" : "OK"} (${failures.length} failures) ===\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
