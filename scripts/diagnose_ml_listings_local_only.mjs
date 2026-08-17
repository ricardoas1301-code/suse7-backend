#!/usr/bin/env node
/**
 * Diagnóstico GET /api/ml/listings — compara local_only vs enrich vivo.
 * Uso (a partir de suse7-backend): node scripts/diagnose_ml_listings_local_only.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(backendRoot, "..");

dotenv.config({ path: path.join(backendRoot, ".env.vercel") });
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] != null ? String(argv[i + 1]) : fallback;
};

const API_BASE = String(arg("--api-base", process.env.S7_API_BASE || "http://localhost:3001")).replace(/\/+$/, "");
const USER_ID = arg("--user-id", "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50");
const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios.");
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

async function probeListings(token, query) {
  const url = `${API_BASE}/api/ml/listings${query}`;
  const started = Date.now();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const elapsedMs = Date.now() - started;
  const json = await res.json().catch(() => ({}));
  const count = Array.isArray(json.listings) ? json.listings.length : 0;
  return { url, status: res.status, elapsedMs, count, ok: json.ok === true };
}

async function countDbListings(userId) {
  const { count, error } = await sb
    .from("marketplace_listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw error;
  return count ?? 0;
}

const token = await resolveAccessTokenForUser(USER_ID);
const dbCount = await countDbListings(USER_ID);

const noAuthLocal = await (async () => {
  const started = Date.now();
  const res = await fetch(`${API_BASE}/api/ml/listings?local_only=1`);
  return { status: res.status, elapsedMs: Date.now() - started };
})();

const localOnly = await probeListings(token, "?local_only=1");
const full = await probeListings(token, "");

const report = {
  generated_at: new Date().toISOString(),
  user_id: USER_ID,
  api_base: API_BASE,
  db_marketplace_listings_count: dbCount,
  without_auth: noAuthLocal,
  with_auth_local_only: localOnly,
  with_auth_full: full,
};

const outPath = path.join(root, "scripts", "output", `diagnose_ml_listings_local_only_${Date.now()}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));
console.log("\nRelatório:", outPath);
