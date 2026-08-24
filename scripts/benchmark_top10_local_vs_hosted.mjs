#!/usr/bin/env node
/**
 * Benchmark read-only — /api/sales/top10 Local vs DEV Hosted.
 * Uso: node scripts/benchmark_top10_local_vs_hosted.mjs [--user-id uuid]
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

const LOCAL_BASE = String(arg("--local-base", "http://localhost:3001")).replace(/\/+$/, "");
const HOSTED_BASE = String(arg("--hosted-base", "https://suse7-backend-dev.vercel.app")).replace(/\/+$/, "");
const USER_ID = arg("--user-id", "ca8e3d58-0899-4978-8663-00b7b179fe0b");
const QUERY = "?period_preset=60d&ranking_limit=10";

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function tokenForUser(userId) {
  const { data: userRes, error } = await sb.auth.admin.getUserById(String(userId));
  if (error) throw error;
  const email = userRes?.user?.email;
  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr) throw linkErr;
  const otp = link?.properties?.email_otp;
  const verifyRes = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "email", token: otp, email }),
  });
  const verifyJson = await verifyRes.json();
  if (!verifyJson?.access_token) throw new Error("access_token não obtido");
  return verifyJson.access_token;
}

/**
 * @param {string} label
 * @param {string} base
 * @param {string} token
 */
async function probe(label, base, token) {
  const url = `${base}/api/sales/top10${QUERY}`;
  const started = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  const elapsedMs = Date.now() - started;
  return {
    label,
    base,
    status: res.status,
    elapsed_ms: elapsedMs,
    ok: res.status === 200 && json?.ok === true,
    orders_count: json?.summary?.orders_count ?? null,
    ranking_lengths: json?.rankings
      ? {
          quantity: Array.isArray(json.rankings.listings_by_quantity)
            ? json.rankings.listings_by_quantity.length
            : null,
          revenue: Array.isArray(json.rankings.listings_by_gross_revenue)
            ? json.rankings.listings_by_gross_revenue.length
            : null,
          profit: Array.isArray(json.rankings.listings_by_net_profit)
            ? json.rankings.listings_by_net_profit.length
            : null,
        }
      : null,
    contract_keys: json && typeof json === "object" ? Object.keys(json).sort() : [],
  };
}

const token = await tokenForUser(USER_ID);
const local = await probe("local", LOCAL_BASE, token);
const hosted = await probe("hosted", HOSTED_BASE, token);

const contractEquivalent =
  JSON.stringify(local.contract_keys) === JSON.stringify(hosted.contract_keys) &&
  local.status === hosted.status &&
  local.ok === hosted.ok;

const report = {
  generated_at: new Date().toISOString(),
  user_id: USER_ID,
  local,
  hosted,
  contract_equivalent: contractEquivalent,
  elapsed_delta_ms: Math.abs((local.elapsed_ms ?? 0) - (hosted.elapsed_ms ?? 0)),
};

const outPath = path.join(root, "scripts/output/BENCHMARK_TOP10_LOCAL_VS_HOSTED.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
