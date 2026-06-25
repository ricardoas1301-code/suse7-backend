#!/usr/bin/env node
/**
 * Cenários acelerados Fase 2.1 (DEV) — NÃO altera billing_cycle_anchor.
 * Requer BILLING_RENEWAL_TEST_ACCELERATED=1 no processo do backend ao rodar o job.
 *
 * Uso:
 *   node scripts/billingPhase21AcceleratedScenario.mjs --email=... --scenario=active
 *   node scripts/billingPhase21AcceleratedScenario.mjs --email=... --scenario=warning --run-engine
 *   node scripts/billingPhase21AcceleratedScenario.mjs --email=... --scenario=restore
 *
 * Cenários: active | warning | danger | critical | grace | suspended | reactivated-hint | restore
 */

import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

/** Scripts DEV: 1 minuto = 1 dia simulado (alinha com BILLING_RENEWAL_TEST_ACCELERATED=1). */
const MS_SIM = 60 * 1000;

const { createClient } = await import("@supabase/supabase-js");
const { reconcileOpenRenewalCyclesForSubscription } = await import(
  "../src/billing/services/billingRenewalCycleConsistencyService.js"
);

function parseArgs() {
  const email = process.argv.find((a) => a.startsWith("--email="))?.split("=")[1]?.trim().toLowerCase();
  const scenario = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1]?.trim().toLowerCase();
  const runEngine = process.argv.includes("--run-engine");
  const apiBase =
    process.argv.find((a) => a.startsWith("--api="))?.split("=")[1]?.trim() ||
    process.env.SUSE7_API_BASE_URL ||
    "https://suse7-backend-dev.vercel.app";
  return { email, scenario, runEngine, apiBase };
}

function addSimDays(base, simDays) {
  return new Date(base.getTime() + simDays * MS_SIM);
}

async function findUserAndSubscription(supabase, email) {
  const { data: users, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const user = users.users.find((u) => String(u.email || "").toLowerCase() === email);
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const { data: subs, error: subErr } = await supabase
    .from("billing_subscriptions")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (subErr) throw subErr;

  const sub =
    subs?.find((s) => String(s.status).toLowerCase() === "active") ??
    subs?.find((s) => String(s.provider).toLowerCase() === "asaas") ??
    subs?.[0];
  if (!sub) throw new Error("Nenhuma billing_subscriptions para o seller");
  return { user, sub, subs };
}

async function snapshotSubscription(supabase, sub) {
  const meta = sub.metadata && typeof sub.metadata === "object" ? { ...sub.metadata } : {};
  if (meta._billing_test_snapshot) return;
  meta._billing_test_snapshot = {
    status: sub.status,
    current_period_start: sub.current_period_start,
    current_period_end: sub.current_period_end,
    next_billing_at: sub.next_billing_at,
    next_due_date: sub.next_due_date,
    metadata: { ...meta },
    saved_at: new Date().toISOString(),
  };
  await supabase.from("billing_subscriptions").update({ metadata: meta }).eq("id", sub.id);
}

function buildScenarioDates(scenario, now) {
  /** renewal_due = next_billing_at lógico */
  switch (scenario) {
    case "active":
      return {
        current_period_end: addSimDays(now, 5),
        next_billing_at: addSimDays(now, 6),
        renewal_due_date: addSimDays(now, 5),
        clear_grace: true,
      };
    case "warning":
      return {
        current_period_end: addSimDays(now, 3),
        next_billing_at: addSimDays(now, 4),
        renewal_due_date: addSimDays(now, 3),
        clear_grace: true,
      };
    case "danger":
      return {
        current_period_end: addSimDays(now, 2),
        next_billing_at: addSimDays(now, 3),
        renewal_due_date: addSimDays(now, 2),
        clear_grace: true,
      };
    case "critical":
      return {
        current_period_end: addSimDays(now, 1),
        next_billing_at: addSimDays(now, 2),
        renewal_due_date: addSimDays(now, 1),
        clear_grace: true,
      };
    case "grace":
      return {
        current_period_end: addSimDays(now, -1),
        next_billing_at: addSimDays(now, 0),
        renewal_due_date: addSimDays(now, -1),
        grace_period_ends_at: addSimDays(now, 9),
        clear_grace: false,
        force_grace_meta: true,
      };
    case "suspended":
      return {
        current_period_end: addSimDays(now, -11),
        next_billing_at: addSimDays(now, -10),
        renewal_due_date: addSimDays(now, -11),
        clear_grace: false,
        force_suspended_meta: true,
      };
    default:
      return null;
  }
}

async function applyScenario(supabase, user, sub, scenario) {
  await snapshotSubscription(supabase, sub);
  const now = new Date();
  const dates = buildScenarioDates(scenario, now);
  if (!dates) throw new Error(`Cenário inválido: ${scenario}`);

  const meta = sub.metadata && typeof sub.metadata === "object" ? { ...sub.metadata } : {};
  delete meta.renewal_subscription_status;
  delete meta.delinquency_status;
  delete meta.grace_period_ends_at;
  delete meta.access_suspended_at;
  if (dates.clear_grace) {
    meta.delinquency_status = "none";
  }
  if (dates.force_grace_meta) {
    meta.renewal_subscription_status = "GRACE_PERIOD";
    meta.delinquency_status = "grace";
    meta.grace_period_ends_at = dates.grace_period_ends_at.toISOString();
  }
  if (dates.force_suspended_meta) {
    meta.renewal_subscription_status = "SUSPENDED";
    meta.delinquency_status = "suspended";
    meta.access_suspended_at = now.toISOString();
  }

  const nextDueIso = dates.next_billing_at.toISOString();
  const patch = {
    current_period_end: dates.current_period_end.toISOString(),
    next_due_date: nextDueIso.slice(0, 10),
    metadata: meta,
    updated_at: now.toISOString(),
  };
  if (scenario === "active") {
    patch.status = "active";
  }
  if (scenario === "suspended") {
    patch.status = "past_due";
  }
  if (scenario === "grace") {
    patch.status = "active";
  }

  const { error } = await supabase.from("billing_subscriptions").update(patch).eq("id", sub.id);
  if (error) throw error;

  const { canonicalCycle: openCycle } = await reconcileOpenRenewalCyclesForSubscription(supabase, sub.id, {
    userId: user.id,
    reason: "accelerated_scenario_apply",
  });
  if (openCycle?.id) {
    const cyclePatch = {
      renewal_due_date: dates.renewal_due_date.toISOString(),
      cycle_end: dates.current_period_end.toISOString(),
      updated_at: now.toISOString(),
    };
    const { error: cycleErr } = await supabase
      .from("billing_renewal_cycles")
      .update(cyclePatch)
      .eq("id", openCycle.id);
    if (cycleErr) throw cycleErr;
  }

  console.info("[BILLING TEST] scenario_applied", {
    status_transition: `scenario_${scenario}`,
    user_id: user.id,
    subscription_id: sub.id,
    old_status: sub.status,
    new_status: patch.status ?? sub.status,
    timestamp: now.toISOString(),
    current_period_end: patch.current_period_end,
    next_due_date: patch.next_due_date,
    renewal_due_date: dates.renewal_due_date.toISOString(),
    renewal_cycle_id: openCycle?.id ?? null,
    sim_day_ms: MS_SIM,
    note: "billing_cycle_anchor NÃO foi alterado",
  });

  return { renewal_due_date: dates.renewal_due_date };
}

async function restoreSnapshot(supabase, sub) {
  const meta = sub.metadata && typeof sub.metadata === "object" ? sub.metadata : {};
  const snap = meta._billing_test_snapshot;
  if (!snap) throw new Error("Sem snapshot _billing_test_snapshot — rode um cenário antes ou restaure manualmente");
  const nextMeta = { ...snap.metadata };
  delete nextMeta._billing_test_snapshot;
  const restorePatch = {
    status: snap.status,
    current_period_start: snap.current_period_start,
    current_period_end: snap.current_period_end,
    next_due_date: snap.next_due_date ?? null,
    metadata: nextMeta,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("billing_subscriptions").update(restorePatch).eq("id", sub.id);
  if (error) throw error;
  console.info("[BILLING TEST] status_transition", {
    status_transition: "restore_snapshot",
    subscription_id: sub.id,
    timestamp: new Date().toISOString(),
  });
}

async function runRenewalEngine(apiBase) {
  const secret = process.env.JOB_SECRET || process.env.DEV_JOB_SECRET || process.env.S7_DEV_JOB_SECRET;
  if (!secret) {
    console.warn("[BILLING TEST] skip_engine — defina JOB_SECRET ou DEV_JOB_SECRET");
    return;
  }
  const url = `${apiBase.replace(/\/$/, "")}/api/jobs/billing-renewal-engine`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Job-Secret": secret },
    body: JSON.stringify({ limit: 50 }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  console.info("[BILLING TEST] renewal_engine_invoked", {
    url,
    http_status: res.status,
    ok: res.ok,
    body,
  });
}

async function main() {
  const { email, scenario, runEngine, apiBase } = parseArgs();
  if (!email || !scenario) {
    console.error(
      "Uso: node scripts/billingPhase21AcceleratedScenario.mjs --email=... --scenario=active|warning|danger|critical|grace|suspended|restore [--run-engine] [--api=URL]"
    );
    process.exit(1);
  }

  if (process.env.BILLING_RENEWAL_TEST_ACCELERATED !== "1") {
    console.warn(
      "[BILLING TEST] AVISO: defina BILLING_RENEWAL_TEST_ACCELERATED=1 no ambiente do backend DEV antes do job para 1 min = 1 dia simulado."
    );
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { user, sub } = await findUserAndSubscription(supabase, email);

  if (scenario === "restore") {
    await restoreSnapshot(supabase, sub);
    return;
  }

  if (scenario === "reactivated-hint") {
    console.info("[BILLING TEST] reactivated_hint", {
      message:
        "Simule REACTIVATED via UI: Renovar agora → pagamento confirmado → webhook/refresh. Depois rode --scenario=restore.",
      user_id: user.id,
      subscription_id: sub.id,
    });
    return;
  }

  await applyScenario(supabase, user, sub, scenario);

  if (runEngine) {
    await runRenewalEngine(apiBase);
  } else {
    console.info("[BILLING TEST] next_step", {
      message: "Rode com --run-engine ou POST /api/jobs/billing-renewal-engine no DEV",
      wait_minutes: "1 min ≈ 1 dia simulado",
    });
  }
}

main().catch((err) => {
  console.error("[BILLING TEST] scenario_failed", { error_message: err?.message });
  process.exit(1);
});
