#!/usr/bin/env node
/**
 * Identifica seller de teste billing (DEV).
 *
 * Uso:
 *   node scripts/billingPhase21DiagnoseSeller.mjs --email=lojarfmoveis@gmail.com
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const { createClient } = await import("@supabase/supabase-js");
const { resolveSubscriptionBillingCycle } = await import("../src/billing/services/billingCycleService.js");

const emailArg = process.argv.find((a) => a.startsWith("--email="));
const email = emailArg ? emailArg.split("=")[1]?.trim().toLowerCase() : null;

if (!email) {
  console.error("Uso: node scripts/billingPhase21DiagnoseSeller.mjs --email=<seller@email.com>");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function resolveSellerCompanyId(userId) {
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (!profile) return { seller_company_id: null, profile: null };
  const companyId =
    profile.seller_company_id ??
    profile.company_id ??
    profile.empresa_id ??
    profile.default_company_id ??
    null;
  return { seller_company_id: companyId, profile };
}

async function main() {
  const { data: users, error: userErr } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (userErr) throw userErr;
  const user = users.users.find((u) => String(u.email || "").toLowerCase() === email);
  if (!user) {
    console.error("[BILLING TEST] seller_not_found", { email });
    process.exit(1);
  }

  const { data: subs, error: subErr } = await supabase
    .from("billing_subscriptions")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (subErr) throw subErr;

  const active =
    subs?.find((s) => String(s.status).toLowerCase() === "active") ??
    subs?.find((s) => String(s.provider).toLowerCase() === "asaas") ??
    subs?.[0] ??
    null;

  const company = await resolveSellerCompanyId(user.id);
  const cycle = active ? resolveSubscriptionBillingCycle(active) : null;
  const meta = active?.metadata && typeof active.metadata === "object" ? active.metadata : {};

  const { data: renewalCycles } = await supabase
    .from("billing_renewal_cycles")
    .select("id, renewal_status, renewal_due_date, renewal_strategy, generated_payment_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(5);

  console.info("[BILLING TEST] seller_identified", {
    email,
    user_id: user.id,
    seller_company_id: company.seller_company_id,
    subscription_id: active?.id ?? null,
    subscription_status: active?.status ?? null,
    plan_id: active?.plan_id ?? null,
    plan_key: active?.plan_key ?? null,
    billing_cycle_anchor: cycle?.billing_cycle_anchor ?? meta.billing_cycle_anchor ?? null,
    current_period_start: active?.current_period_start ?? cycle?.current_period_start ?? null,
    current_period_end: active?.current_period_end ?? cycle?.current_period_end ?? null,
    next_billing_at: active?.next_billing_at ?? active?.next_due_date ?? cycle?.next_billing_at ?? null,
    renewal_subscription_status: meta.renewal_subscription_status ?? null,
    delinquency_status: meta.delinquency_status ?? null,
    grace_period_ends_at: meta.grace_period_ends_at ?? null,
    open_renewal_cycles: renewalCycles ?? [],
    accelerated_mode_hint: "Defina BILLING_RENEWAL_TEST_ACCELERATED=1 no backend DEV (1 min = 1 dia simulado)",
  });
}

main().catch((err) => {
  console.error("[BILLING TEST] diagnose_failed", { error_message: err?.message });
  process.exit(1);
});
