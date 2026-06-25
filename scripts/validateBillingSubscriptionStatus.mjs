#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });
loadEnv({ path: "../suse7-frontend/.env.development" });
loadEnv();

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim();
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";
const targets = [
  { label: "local", baseUrl: (process.env.S7_BILLING_LOCAL_BASE_URL || "http://localhost:3001").replace(/\/+$/, "") },
  { label: "dev", baseUrl: (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "") },
];

if (!supabaseUrl || !anonKey) {
  console.error("Falta SUPABASE_URL e anon key para login de teste.");
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
  console.error("Falha no login de teste:", authError?.message || "sem token");
  process.exit(1);
}

const token = authData.session.access_token;
const requiredTop = [
  "access",
  "usage",
  "breakdowns",
  "limits",
  "plan",
  "subscriptions",
  "current_period_start",
  "current_period_end",
  "next_billing_at",
  "billing_cycle_anchor",
];
const requiredUsage = ["total_sales_month", "limit_sales_month", "usage_percent", "near_limit", "period_start", "period_end"];
const requiredLimits = ["monthly_sales_limit"];
/** @type {string[]} */
const results = [];

for (const target of targets) {
  const res = await fetch(`${target.baseUrl}/api/billing/subscription/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (res.status !== 200) {
    results.push(`FAIL ${target.label}: HTTP ${res.status} — ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`);
    continue;
  }

  const missingTop = requiredTop.filter((key) => !(key in (body || {})));
  const missingUsage = requiredUsage.filter((key) => !(key in (body?.usage || {})));
  const missingLimits = requiredLimits.filter((key) => !(key in (body?.limits || {})));
  const breakdownOk =    body?.breakdowns &&
    typeof body.breakdowns === "object" &&
    ["marketplaces", "companies", "accounts"].every((key) => key in body.breakdowns);

  if (missingTop.length > 0 || missingUsage.length > 0 || missingLimits.length > 0 || !breakdownOk) {
    results.push(
      `FAIL ${target.label}: payload incompleto missingTop=${missingTop.join(",")} missingUsage=${missingUsage.join(",")} missingLimits=${missingLimits.join(",")} breakdownOk=${breakdownOk}`
    );    continue;
  }

  const usageMatchesCycle =
    body?.usage?.period_start &&
    body?.usage?.period_end &&
    body?.current_period_start &&
    body?.current_period_end &&
    String(body.usage.period_start) === String(body.current_period_start).slice(0, 10) &&
    String(body.usage.period_end) === String(body.current_period_end).slice(0, 10);

  if (!usageMatchesCycle) {
    results.push(
      `FAIL ${target.label}: usage.period_start/end divergem do ciclo atual (${body?.usage?.period_start}..${body?.usage?.period_end})`
    );
    continue;
  }

  results.push(
    `PASS ${target.label}: 200 access.can_access=${Boolean(body.access?.can_access)} usage.total_sales_month=${body.usage.total_sales_month} cycle=${body.usage.period_start}..${body.usage.period_end} subscriptions=${Array.isArray(body.subscriptions) ? body.subscriptions.length : 0}`
  );}

for (const line of results) {
  if (line.startsWith("PASS")) console.log(line);
  else console.error(line);
}

if (results.some((line) => line.startsWith("FAIL"))) process.exit(1);
