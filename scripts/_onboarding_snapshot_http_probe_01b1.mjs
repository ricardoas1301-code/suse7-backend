#!/usr/bin/env node
/**
 * LOCAL_ONLY — HTTP GET snapshot + latch side-effect audit (01B.1)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secrets = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/output/.dev_v2_hosted_secrets.local"), "utf8"),
);

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...parseDotEnv(path.join(root, ".env")), ...parseDotEnv(path.join(root, ".env.local")) };
const url = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const apiBase = (process.env.API_BASE || "http://localhost:3001").replace(/\/+$/, "");

if (!url || !serviceKey) {
  console.error(JSON.stringify({ ok: false, code: "MISSING_ENV" }));
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: companies } = await admin
  .from("seller_companies")
  .select("user_id")
  .eq("is_primary", true)
  .limit(1);

const userId = companies?.[0]?.user_id;
if (!userId) {
  console.error(JSON.stringify({ ok: false, code: "NO_SELLER" }));
  process.exit(1);
}

const { data: profileRow } = await admin.from("profiles").select("email").eq("id", userId).maybeSingle();
const sellerEmail = String(profileRow?.email ?? "").trim();

const latchSelect =
  "operational_cycle_configured_at, first_marketplace_connected_at, initial_configuration_completed_at";

const beforeProfile = await admin.from("profiles").select(latchSelect).eq("id", userId).maybeSingle();

let accessToken = null;
if (sellerEmail) {
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: sellerEmail,
  });
  if (!linkErr && linkData?.properties?.hashed_token) {
    const { data: verifyData } = await admin.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
    accessToken = verifyData?.session?.access_token ?? null;
  }
}

if (!accessToken) {
  const password = secrets.fresh_seller_password;
  if (sellerEmail && password) {
    const anon = createClient(url, secrets.anon_key || env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    const { data: signIn } = await anon.auth.signInWithPassword({ email: sellerEmail, password });
    accessToken = signIn?.session?.access_token ?? null;
  }
}

if (!accessToken) {
  console.error(JSON.stringify({ ok: false, code: "NO_SESSION", hint: "configure fresh_seller_email/password in secrets" }));
  process.exit(1);
}

const snapRes = await fetch(`${apiBase}/api/onboarding/configuration-snapshot`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const snapBody = await snapRes.json().catch(() => ({}));

const afterProfile = await admin.from("profiles").select(latchSelect).eq("id", userId).maybeSingle();

const out = {
  ok: snapRes.status === 200 && snapBody?.configuration?.percent === 33,
  http_status: snapRes.status,
  configuration: snapBody?.configuration ?? null,
  milestones: (snapBody?.milestones ?? []).map((m) => ({ id: m.id, status: m.status })),
  latch_before: beforeProfile.data,
  latch_after: afterProfile.data,
  latch_unchanged:
    JSON.stringify(beforeProfile.data) === JSON.stringify(afterProfile.data),
  get_side_effects: JSON.stringify(beforeProfile.data) === JSON.stringify(afterProfile.data) ? 0 : 1,
  user_id_masked: `${String(userId).slice(0, 8)}…${String(userId).slice(-4)}`,
};

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok && out.get_side_effects === 0 ? 0 : 1);
