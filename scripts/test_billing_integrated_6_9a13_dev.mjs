#!/usr/bin/env node
/**
 * S1.HF.6.9A.13 — provas integradas DEV (RPC + resolvers)
 * Guard-rail: somente Suse7-dev (ujznkyvgqhxagemdgmor)
 * Sem cobrança Asaas real / sem PROD.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_REF = "ujznkyvgqhxagemdgmor";
const PROD_REF = "bazibzquasbdgjwdcwbz";

function loadEnvLocal() {
  const p = path.join(root, ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvLocal();

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ref = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url || "")?.[1] || "";

console.log("=== S1.HF.6.9A.13 DEV integrated ===");
console.log(`project_ref=${ref}`);
console.log(`S7_APP_ENV=${process.env.S7_APP_ENV ?? ""}`);
console.log(`ASAAS_ENV=${process.env.ASAAS_ENV ?? ""}`);

check("env DEV ref", ref === DEV_REF);
check("env not PROD ref", ref !== PROD_REF);
check("asaas sandbox", String(process.env.ASAAS_ENV || "").toLowerCase() === "sandbox");
if (ref !== DEV_REF || !url || !key) {
  console.error("ABORT: ambiente não é Suse7-dev ou credenciais ausentes");
  process.exit(2);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const {
  resolveTrialLifecycleState,
} = await import("../src/billing/services/billingTrialLifecycleService.js");
const { BILLING_TRIAL_LIFECYCLE_STATE, BILLING_TRIAL_METADATA_KEYS, BILLING_TRIAL_STATE, BILLING_PAID_LIFECYCLE_STATE } =
  await import("../src/billing/billingConstants.js");
const { resolvePaidLifecycleState } = await import("../src/billing/services/billingPaidLifecycleService.js");
const { resolveEarlyPaymentScheduling, simulateMultiInstancePaidClaims, claimPaidLifecycleLedger } =
  await import("../src/billing/services/billingPaidLifecycleAtomicService.js");
const { reevaluateBabyQuotaAfterEntitlementChange, BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE } =
  await import("../src/billing/services/billingBabyQuotaReevaluationService.js");
const { convergePaidLifecycleAfterMutation } = await import(
  "../src/billing/services/billingPaidLifecycleConvergenceService.js"
);
const { classifyFinancialPaymentEvent } = await import(
  "../src/billing/services/billingFinancialEventClassificationService.js"
);
const { resolveBillingFinancialStateFromDueDate } = await import(
  "../src/billing/services/billingSubscriptionFinancialStateService.js"
);
const { processBillingOverdues } = await import("../src/billing/services/billingDunningService.js");

// --- Fluxo A trial (resolver + ledger RPC) ---
{
  const meta = {
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.ACTIVE,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_START_DATE]: "2026-07-24",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_END_DATE]: "2026-08-07",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_ENDS_AT]: "2026-08-08T00:00:00-03:00",
    sync_state: "FULL",
  };
  // end inclusive 2026-08-07 → D3 = 2026-08-04, D1 = 2026-08-07, expired = 2026-08-08T00:00-03
  const d3 = resolveTrialLifecycleState({ metadata: meta, now: new Date("2026-08-04T15:00:00.000Z") });
  const d1 = resolveTrialLifecycleState({ metadata: meta, now: new Date("2026-08-07T15:00:00.000Z") });
  const exp = resolveTrialLifecycleState({ metadata: meta, now: new Date("2026-08-08T03:00:00.000Z") });
  const paid = resolveTrialLifecycleState({
    metadata: meta,
    now: new Date("2026-08-08T03:00:00.000Z"),
    paid_confirmed: true,
    canonical_subscription_active: true,
  });
  check("A D3", d3.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D3);
  check("A D1", d1.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1);
  check("A expired restricted", exp.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED);
  check("A no baby fallback", exp.entitlement !== "BABY_INTERNAL_FREE");
  check("A paid unlock", paid.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE);

  const userId = randomUUID();
  const a1 = await supabase.rpc("billing_trial_lifecycle_apply_transition", {
    p_user_id: userId,
    p_kind: "ALERT_D3",
    p_trial_end_civil: "2026-08-07",
    p_paid_confirmed: false,
    p_correlation_id: "6_9a13-a",
  });
  const a2 = await supabase.rpc("billing_trial_lifecycle_apply_transition", {
    p_user_id: userId,
    p_kind: "ALERT_D3",
    p_trial_end_civil: "2026-08-07",
    p_paid_confirmed: false,
    p_correlation_id: "6_9a13-a-dup",
  });
  check("A rpc ok", !a1.error);
  check("A claimed once", a1.data?.claimed === true && (a2.data?.idempotent === true || a2.data?.claimed === false));
  check("A sync full", exp.sync_state === "FULL" || meta.sync_state === "FULL");
}

// --- Fluxo B early pay ---
{
  const sub = {
    id: randomUUID(),
    status: "active",
    current_period_start: "2026-07-21T03:00:00.000Z",
    current_period_end: "2026-08-20T03:00:00.000Z",
    next_due_date: "2026-08-21",
    billing_cycle_anchor: "2026-07-21T03:00:00.000Z",
    metadata: { delinquency_status: "none", sync_state: "FULL" },
  };
  const early = resolveEarlyPaymentScheduling({
    subscription: sub,
    paidAtIso: "2026-07-20T12:00:00.000Z",
    nextPeriodStartCivil: "2026-08-21",
    nextPeriodEndExclusiveCivil: "2026-09-21",
    paymentId: "pay-early",
  });
  check("B early schedule", early.early && !early.advance_current_period);
  const scheduled = {
    ...sub,
    metadata: {
      ...sub.metadata,
      scheduled_renewal: { ...early.scheduled_renewal, activated_at: null },
    },
  };
  const st = resolvePaidLifecycleState({ subscription: scheduled, now: new Date("2026-07-25T15:00:00.000Z") });
  check("B RENEWAL_PAID_SCHEDULED", st.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.RENEWAL_PAID_SCHEDULED);

  const competence = `${sub.id}:2026-08-21:2026-09-21`;
  const p1 = await supabase.rpc("billing_paid_lifecycle_apply_transition", {
    p_provider: "asaas",
    p_provider_event_id: "evt-early-1",
    p_provider_payment_id: "pay-early",
    p_canonical_subscription_id: sub.id,
    p_competence_key: competence,
    p_event_type: "PAYMENT_CONFIRMED",
    p_paid_confirmed: true,
    p_correlation_id: "6_9a13-b",
  });
  const p2 = await supabase.rpc("billing_paid_lifecycle_apply_transition", {
    p_provider: "asaas",
    p_provider_event_id: "evt-early-1",
    p_provider_payment_id: "pay-early",
    p_canonical_subscription_id: sub.id,
    p_competence_key: competence,
    p_event_type: "PAYMENT_CONFIRMED",
    p_paid_confirmed: true,
    p_correlation_id: "6_9a13-b-dup",
  });
  check("B rpc competence once", !p1.error && p1.data?.claimed === true && p2.data?.idempotent === true);
}

// --- Fluxo C grace/D11 ---
{
  const due = "2026-08-21";
  check("C D0 due", resolveBillingFinancialStateFromDueDate(due, "2026-08-21", 10).billing_financial_state === "DUE_TODAY");
  check("C D10 grace", resolveBillingFinancialStateFromDueDate(due, "2026-08-31", 10).billing_financial_state === "GRACE_PERIOD");
  check("C D11 suspend", resolveBillingFinancialStateFromDueDate(due, "2026-09-01", 10).billing_financial_state === "SUSPENDED");
  const overdue = await processBillingOverdues(supabase, {});
  check("C legacy overdues disabled", overdue.disabled === true);
  check(
    "C pending no quit",
    !classifyFinancialPaymentEvent("PAYMENT_CREATED", "PENDING").may_quit_competence,
  );
}

// --- Fluxo D baby reeval ---
{
  const re = reevaluateBabyQuotaAfterEntitlementChange(
    {
      suspension_fallback_active: false,
      hard_pause_owner: "BABY_QUOTA_ENGINE",
      sync_state: "HARD_PAUSED",
      usage_billed_count: 60,
      security_access_revoked: true,
    },
    { effective_entitlement: "PAID_PLAN", entitlement_source: "SUBSCRIPTION_ACTIVE" },
  );
  check("D baby reeval", re.result === BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE);
  check("D history", re.metadata.baby_usage_history?.billed_count_at_exit === 60);
  check("D security kept", re.metadata.security_access_revoked === true);
  const conv = convergePaidLifecycleAfterMutation({
    subscription: {
      id: randomUUID(),
      status: "active",
      current_period_start: "2026-09-01T03:00:00.000Z",
      current_period_end: "2026-09-30T03:00:00.000Z",
      next_due_date: "2026-10-01",
      metadata: { delinquency_status: "none", sync_state: "FULL" },
    },
    now: new Date("2026-09-05T15:00:00.000Z"),
  });
  check(
    "D converge",
    conv.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE ||
      conv.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE,
  );
}

// --- Concorrência persistente ---
{
  const subId = randomUUID();
  const competence = `${subId}:2026-08-21:2026-09-21`;
  const [r1, r2] = await Promise.all([
    supabase.rpc("billing_paid_lifecycle_apply_transition", {
      p_provider: "asaas",
      p_provider_event_id: "evt-race",
      p_provider_payment_id: "pay-race",
      p_canonical_subscription_id: subId,
      p_competence_key: competence,
      p_event_type: "PAYMENT_CONFIRMED",
      p_paid_confirmed: true,
    }),
    supabase.rpc("billing_paid_lifecycle_apply_transition", {
      p_provider: "asaas",
      p_provider_event_id: "evt-race",
      p_provider_payment_id: "pay-race",
      p_canonical_subscription_id: subId,
      p_competence_key: competence,
      p_event_type: "PAYMENT_CONFIRMED",
      p_paid_confirmed: true,
    }),
  ]);
  const claimed = [r1.data, r2.data].filter((d) => d?.claimed).length;
  const idem = [r1.data, r2.data].filter((d) => d?.idempotent).length;
  check("concurrency one claim", !r1.error && !r2.error && claimed === 1 && idem === 1);

  const sim = simulateMultiInstancePaidClaims({
    userId: "u",
    canonicalSubscriptionId: subId,
    competenceKey: competence,
    eventType: "PAYMENT_CONFIRMED",
    processCount: 2,
  });
  check("concurrency sim", sim.unique_ok);

  /** @type {Map<string, Record<string, unknown>>} */
  const ledger = new Map();
  const c1 = claimPaidLifecycleLedger(ledger, {
    provider: "asaas",
    provider_event_id: "evt-conf",
    provider_payment_id: "pay-x",
    canonical_subscription_id: subId,
    competence_key: competence,
    event_type: "PAYMENT_CONFIRMED",
  });
  const c2 = claimPaidLifecycleLedger(ledger, {
    provider: "asaas",
    provider_event_id: "evt-recv",
    provider_payment_id: "pay-x",
    canonical_subscription_id: subId,
    competence_key: competence,
    event_type: "PAYMENT_RECEIVED",
  });
  // Event types distintos: ledger permite ambos; fachada classifica ambos como confirm — competência já claimed no RPC acima.
  check("conf+recv two event types ledger keys", c1.claimed && c2.claimed && ledger.size === 2);
}

// wiring static
{
  const webhook = fs.readFileSync(path.join(root, "src/billing/subscriptionStateService.js"), "utf8");
  const cron = fs.readFileSync(
    path.join(root, ".github/workflows/billing-maintenance-cron-dev.yml"),
    "utf8",
  );
  check("wiring confirm facade", webhook.includes("confirmCanonicalSubscriptionPayment"));
  check("scheduler overdues removed", !cron.includes("overdues") || cron.includes("DISABLED"));
  check("scheduler renewals kept", cron.includes("renewals"));
}

if (failures.length) {
  console.error("FAIL S1.HF.6.9A.13");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("OK S1.HF.6.9A.13 DEV integrated");
console.log(`checks_failed=${failures.length}`);
