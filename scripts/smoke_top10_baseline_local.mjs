#!/usr/bin/env node
/**
 * Smoke CPJ-0000B — /api/sales/top10 local (401 sem token; 200 autenticado).
 * Uso: node scripts/smoke_top10_baseline_local.mjs [--api-base http://localhost:3001] [--user-id uuid]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[trimmed.slice(0, eq).trim()] = v;
  }
  return out;
}

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] != null ? String(argv[i + 1]) : fallback;
};

const env = {
  ...parseDotEnv(path.join(root, ".env")),
  ...parseDotEnv(path.join(root, ".env.local")),
};

const API_BASE = String(arg("--api-base", env.S7_API_BASE || "http://localhost:3001")).replace(/\/+$/, "");
const USER_ID = arg("--user-id", "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50");
const SUPABASE_URL = env.SUPABASE_URL?.trim();
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ANON_KEY = env.SUPABASE_ANON_KEY?.trim() || SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(JSON.stringify({ ok: false, error: "missing_supabase_env" }));
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function resolveAccessTokenForUser(userId) {
  const { data: userRes, error } = await sb.auth.admin.getUserById(String(userId));
  if (error) throw error;
  const email = userRes?.user?.email;
  if (!email) throw new Error(`email não encontrado user_id=${userId}`);

  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw linkErr;

  const otp = link?.properties?.email_otp;
  if (!otp) throw new Error("OTP não gerado");

  const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "email", token: otp, email }),
  });
  const verifyJson = await verifyRes.json();
  const token = verifyJson?.access_token;
  if (!token) throw new Error("access_token não obtido");
  return token;
}

const query = "?period_preset=60d&ranking_limit=10";
const url = `${API_BASE}/api/sales/top10${query}`;

/** @type {Record<string, unknown>} */
const report = {
  generated_at: new Date().toISOString(),
  api_base: API_BASE,
  user_id: USER_ID,
  unauthenticated: null,
  authenticated: null,
  pass: false,
};

const unauthRes = await fetch(url);
const unauthJson = await unauthRes.json().catch(() => ({}));
report.unauthenticated = {
  status: unauthRes.status,
  ok: unauthRes.status === 401,
  error: unauthJson?.error ?? null,
};

const started = Date.now();
const token = await resolveAccessTokenForUser(USER_ID);
const authRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const authJson = await authRes.json().catch(() => ({}));
const elapsedMs = Date.now() - started;

report.authenticated = {
  status: authRes.status,
  elapsed_ms: elapsedMs,
  ok: authRes.status === 200 && authJson?.ok === true,
  orders_count: authJson?.summary?.orders_count ?? null,
  rankings: authJson?.rankings
    ? {
        listings_by_quantity: Array.isArray(authJson.rankings.listings_by_quantity)
          ? authJson.rankings.listings_by_quantity.length
          : null,
        listings_by_gross_revenue: Array.isArray(authJson.rankings.listings_by_gross_revenue)
          ? authJson.rankings.listings_by_gross_revenue.length
          : null,
        listings_by_net_profit: Array.isArray(authJson.rankings.listings_by_net_profit)
          ? authJson.rankings.listings_by_net_profit.length
          : null,
      }
    : null,
  has_summary: Boolean(authJson?.summary),
  has_period: Boolean(authJson?.period),
  contract_keys: authJson && typeof authJson === "object" ? Object.keys(authJson).sort() : [],
};

report.pass = Boolean(report.unauthenticated?.ok) && Boolean(report.authenticated?.ok);

const outPath = path.join(root, "scripts/output/SMOKE_TOP10_BASELINE_LOCAL.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
