#!/usr/bin/env node
/**
 * Read-only precheck DEV — billing cron + ml_webhook_events BEFORE retest.
 * Nunca imprime secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const DEV_REF = "alkelcaoexxbamqddaqv";

function readLocalSupabaseEnv() {
  const candidates = [".env.dev-v2.local", ".env.local"];
  for (const name of candidates) {
    const p = path.join(BACKEND_ROOT, name);
    if (!fs.existsSync(p)) continue;
    const vars = {};
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      vars[m[1]] = val;
    }
    if (vars.SUPABASE_URL && vars.SUPABASE_SERVICE_ROLE_KEY) return vars;
  }
  throw new Error("Supabase env local ausente");
}

function refFromUrl(url) {
  try {
    return new URL(url).hostname.split(".")[0].toLowerCase();
  } catch {
    return null;
  }
}

async function billingPrecheck(supabase) {
  const now = new Date().toISOString();
  const { data: subs, error } = await supabase
    .from("billing_subscriptions")
    .select("id, status, provider, current_period_end, metadata, plan_id, user_id")
    .in("status", ["active", "past_due", "pending"]);
  if (error) throw error;

  /** @type {Record<string, unknown>[]} */
  const rows = subs || [];
  const periodCandidates = [];
  for (const row of rows) {
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const cancelAtEnd = meta.cancel_at_period_end === true || meta.cancel_at_period_end === "true";
    const planChangeAtEnd = meta.plan_change_at_period_end === true || meta.plan_change_at_period_end === "true";
    const periodEnd = row.current_period_end ? new Date(String(row.current_period_end)) : null;
    const due =
      (cancelAtEnd || planChangeAtEnd) && periodEnd && !Number.isNaN(periodEnd.getTime()) && periodEnd.getTime() <= Date.now();
    if (due) {
      periodCandidates.push({
        id: row.id,
        status: row.status,
        provider: row.provider,
        current_period_end: row.current_period_end,
        kind: planChangeAtEnd ? "scheduled_plan_downgrade" : cancelAtEnd ? "cancel_to_baby" : "unknown",
      });
    }
  }

  const { count: renewalLockCount } = await supabase
    .from("billing_paid_lifecycle_job_locks")
    .select("*", { count: "exact", head: true });
  const { count: trialLockCount } = await supabase
    .from("billing_trial_lifecycle_job_locks")
    .select("*", { count: "exact", head: true });

  return {
    captured_at: now,
    subscriptions_active_family: rows.length,
    period_expiration_candidates_due_now: periodCandidates.length,
    period_expiration_candidates: periodCandidates,
    renewal_engine_note: "listSubscriptionsApproachingRenewal — may open renewal cycles / Asaas sandbox calls for approaching renewals",
    asaas_expected: "sandbox (DEV Vercel ASAAS_ENV)",
    external_calls_possible: true,
    job_locks_before: {
      billing_paid_lifecycle_job_locks: renewalLockCount ?? 0,
      billing_trial_lifecycle_job_locks: trialLockCount ?? 0,
    },
    expected_writes_if_candidates_zero: "minimal — scanned counts only; renewal-engine may still emit hooks for approaching renewals",
  };
}

async function mlWebhookPrecheck(supabase) {
  const statuses = ["pending", "queued", "processing", "done", "ignored", "failed", "error"];
  /** @type {Record<string, number>} */
  const byStatus = {};
  for (const st of statuses) {
    const { count } = await supabase.from("ml_webhook_events").select("*", { count: "exact", head: true }).eq("status", st);
    byStatus[st] = count ?? 0;
  }
  const { count: total } = await supabase.from("ml_webhook_events").select("*", { count: "exact", head: true });
  const processable = (byStatus.pending ?? 0) + (byStatus.queued ?? 0);
  return {
    captured_at: new Date().toISOString(),
    project_ref: DEV_REF,
    total_events: total ?? 0,
    by_status: byStatus,
    cron_batch_limit: 20,
    processable_estimate: Math.min(processable, 20),
    idempotent: true,
    initial_sync_risk: false,
  };
}

async function main() {
  const env = readLocalSupabaseEnv();
  const ref = refFromUrl(env.SUPABASE_URL || "");
  if (ref !== DEV_REF) throw new Error(`Supabase ref mismatch: expected ${DEV_REF}, got ${ref || "unknown"}`);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const billing = await billingPrecheck(supabase);
  const ml = await mlWebhookPrecheck(supabase);

  const out = {
    generated_at: new Date().toISOString(),
    supabase_ref: ref,
    billing_dev_precheck: billing,
    ml_webhook_dev_precheck: ml,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `DEV_CRON_PRECHECK_BEFORE_${DATE}.json`), JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify({
      ok: true,
      period_candidates: billing.period_expiration_candidates_due_now,
      subs_active_family: billing.subscriptions_active_family,
      ml_processable_estimate: ml.processable_estimate,
      ml_total: ml.total_events,
    }),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
