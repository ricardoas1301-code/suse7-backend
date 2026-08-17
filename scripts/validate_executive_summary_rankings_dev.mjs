#!/usr/bin/env node
/**
 * Valida executive-summary P_2.1.4 no DEV Vercel.
 * Uso: node scripts/validate_executive_summary_rankings_dev.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(
  /\/+$/,
  "",
);
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";

/** @type {string[]} */
const results = [];

function pass(msg) {
  results.push(`PASS: ${msg}`);
  console.log(`PASS: ${msg}`);
}

function fail(msg, detail) {
  const line = detail ? `FAIL: ${msg} — ${detail}` : `FAIL: ${msg}`;
  results.push(line);
  console.error(line);
}

async function main() {
  if (!supabaseUrl || !serviceKey) {
    fail("env", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
    process.exit(1);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: usersData } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  let userId = usersData?.users?.find((u) => u.email === testEmail)?.id;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (error) {
      fail("auth user", error.message);
      process.exit(1);
    }
    userId = data.user?.id;
  }

  let token = process.env.DEV_BILLING_TEST_JWT?.trim() || "";

  if (!token) {
    const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
    if (anonKey) {
      const client = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: signIn, error: signErr } = await client.auth.signInWithPassword({
        email: testEmail,
        password: testPassword,
      });
      if (!signErr && signIn.session?.access_token) {
        token = signIn.session.access_token;
      }
    }
  }

  if (!token) {
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: testEmail,
    });
    const tokenHash = linkData?.properties?.hashed_token;
    const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || linkData?.properties?.anon_key;
    if (linkErr || !tokenHash) {
      fail("auth token", linkErr?.message ?? "generateLink sem hashed_token");
      process.exit(1);
    }
    const pubKey =
      process.env.SUPABASE_ANON_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
      process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
      serviceKey;
    if (!pubKey) {
      fail("auth token", "defina SUPABASE_ANON_KEY ou DEV_BILLING_TEST_JWT para validar");
      process.exit(1);
    }
    const pub = createClient(supabaseUrl, pubKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: otpData, error: otpErr } = await pub.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });
    if (otpErr || !otpData.session?.access_token) {
      fail("verifyOtp", otpErr?.message ?? "sem access_token");
      process.exit(1);
    }
    token = otpData.session.access_token;
  }
  const url = `${baseUrl}/api/sales/executive-summary?period_preset=60d&ranking_limit=10`;
  const started = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const elapsedMs = Date.now() - started;
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text?.slice(0, 500) };
  }

  console.info("[validate executive-summary]", { status: res.status, elapsedMs, url });

  if (res.status === 500) {
    fail("HTTP", `500 em ${elapsedMs}ms`);
    process.exit(1);
  }
  if (res.status !== 200) {
    fail("HTTP", `${res.status} em ${elapsedMs}ms — ${JSON.stringify(body)?.slice(0, 300)}`);
    process.exit(1);
  }
  pass(`HTTP 200 em ${elapsedMs}ms (sem 500)`);

  const periodPreset = body?.period?.preset;
  if (periodPreset === "60d") pass("period.preset = 60d");
  else fail("period.preset", String(periodPreset ?? "null"));

  if (periodPreset === "all") fail("period", "ainda retorna all");
  else pass("period não é all");

  const rankings = body?.rankings ?? {};
  for (const key of ["listings_by_quantity", "listings_by_gross_revenue", "listings_by_net_profit"]) {
    if (Array.isArray(rankings[key])) {
      pass(`rankings.${key} presente (${rankings[key].length} itens)`);
    } else {
      fail(`rankings.${key}`, "ausente ou não é array");
    }
  }

  const warnings = body?.data_quality?.warnings;
  if (Array.isArray(warnings) && warnings.some((w) => String(w).includes("60 dias"))) {
    pass("data_quality warning de coerção 60d (se aplicável)");
  }

  console.info("[summary sample]", {
    orders_count: body?.summary?.orders_count ?? null,
    qty_rank_1: rankings.listings_by_quantity?.[0]?.title ?? null,
    gross_rank_1: rankings.listings_by_gross_revenue?.[0]?.gross_sales_brl ?? null,
    profit_rank_1: rankings.listings_by_net_profit?.[0]?.contribution_profit_brl ?? null,
    truncated_scan: body?.truncated_scan ?? null,
  });

  const failed = results.some((r) => r.startsWith("FAIL:"));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
