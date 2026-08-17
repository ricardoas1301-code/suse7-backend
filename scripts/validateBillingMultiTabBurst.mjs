#!/usr/bin/env node
/**
 * Burst multiaba — subscription/status coalescing + cache.
 * Uso: node scripts/validateBillingMultiTabBurst.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });
loadEnv({ path: "../suse7-frontend/.env.development" });

const baseUrl = (process.env.S7_BILLING_LOCAL_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim();
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";
const CONCURRENT = Number(process.env.S7_BILLING_BURST_CONCURRENT ?? 10);

if (!supabaseUrl || !anonKey) {
  console.error("Falta SUPABASE_URL / anon key.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
  email: testEmail,
  password: testPassword,
});
if (authError || !authData.session?.access_token) {
  console.error("Login falhou:", authError?.message);
  process.exit(1);
}

const token = authData.session.access_token;
const url = `${baseUrl}/api/billing/subscription/status`;
const headers = { Authorization: `Bearer ${token}` };

/** @type {number[]} */
const durations = [];

const wallStart = Date.now();
const results = await Promise.all(
  Array.from({ length: CONCURRENT }, async (_, i) => {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      const ms = Date.now() - t0;
      durations.push(ms);
      return { i: i + 1, status: res.status, ms, timedOut: false };
    } catch (e) {
      const ms = Date.now() - t0;
      durations.push(ms);
      return { i: i + 1, status: 0, ms, timedOut: true, error: e?.message ?? "error" };
    }
  })
);
const wallMs = Date.now() - wallStart;

durations.sort((a, b) => a - b);
const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
const max = durations[durations.length - 1] ?? 0;
const timeouts = results.filter((r) => r.timedOut || r.status === 408).length;
const ok = results.filter((r) => r.status === 200).length;

console.log(
  JSON.stringify(
    {
      endpoint: "/api/billing/subscription/status",
      concurrent: CONCURRENT,
      wall_ms: wallMs,
      ok,
      timeouts,
      p50_ms: p50,
      p95_ms: p95,
      max_ms: max,
      results,
    },
    null,
    2
  )
);

if (timeouts > 0 || ok < CONCURRENT) process.exit(1);
