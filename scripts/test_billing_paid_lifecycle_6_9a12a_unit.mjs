#!/usr/bin/env node
/**
 * S1.HF.6.9A.12A — runtime wiring + stale-owner hardening (estático)
 * Sem DB / SQL / Asaas / deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const {
  classifyFinancialPaymentEvent,
  BILLING_PENDING_FINANCIAL_EVENTS,
  BILLING_CONFIRMED_FINANCIAL_EVENTS,
} = await import("../src/billing/services/billingFinancialEventClassificationService.js");
const {
  reevaluateBabyQuotaAfterEntitlementChange,
  BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE,
} = await import("../src/billing/services/billingBabyQuotaReevaluationService.js");
const {
  convergePaidLifecycleAfterMutation,
  BILLING_PAID_STATE_KIND,
  isPaidLifecycleTransientState,
} = await import("../src/billing/services/billingPaidLifecycleConvergenceService.js");
const {
  resolveCanonicalBillableSubscription,
  classifyPaymentSubscriptionLink,
} = await import("../src/billing/services/billingCanonicalSubscriptionService.js");
const { resolveBillingDunningGracePeriodDays, processBillingOverdues } = await import(
  "../src/billing/services/billingDunningService.js"
);
const { resolveBillingFinancialStateFromDueDate } = await import(
  "../src/billing/services/billingSubscriptionFinancialStateService.js"
);
const { simulateMultiInstancePaidClaims, resolveSuspendVsPaymentRace } = await import(
  "../src/billing/services/billingPaidLifecycleAtomicService.js"
);
const { BILLING_PAID_LIFECYCLE_STATE, BILLING_HARD_PAUSE_OWNER, BILLING_ACCESS_PROFILE } =
  await import("../src/billing/billingConstants.js");
const { activateSubscriptionFromPaidPayment } = await import(
  "../src/billing/services/billingSubscriptionActivationService.js"
);

// --- 1–2 wiring: entry points call facade, not activate directly ---
{
  const webhook = read("src/billing/subscriptionStateService.js");
  const sync = read("src/billing/services/billingPaymentSyncService.js");
  const checkout = read("src/billing/services/billingSubscriptionService.js");
  const dunning = read("src/billing/services/billingDunningService.js");
  const confirm = read("src/billing/services/billingConfirmCanonicalSubscriptionPaymentService.js");
  check("1 webhook uses confirmCanonical", webhook.includes("confirmCanonicalSubscriptionPayment"));
  check("1b webhook no direct activate", !webhook.includes("activateSubscriptionFromPaidPayment"));
  check("1c sync uses facade", sync.includes("confirmCanonicalSubscriptionPayment"));
  check("1d checkout uses facade", checkout.includes("confirmCanonicalSubscriptionPayment"));
  check("1e recovery uses facade", dunning.includes("confirmCanonicalSubscriptionPayment"));
  check(
    "2 webhook no direct period advance helper",
    !webhook.includes("buildConfirmedSubscriptionPeriodPatch") &&
      !webhook.includes("current_period_start:"),
  );
  check("2b confirm owns activation", confirm.includes("viaCanonicalFacade: true"));
}

// --- architectural: DB writes of cycle/entitlement fields fora da fachada/autorizados ---
{
  const allow = new Set([
    "src/billing/services/billingConfirmCanonicalSubscriptionPaymentService.js",
    "src/billing/services/billingSubscriptionRenewalCompletionService.js",
    "src/billing/services/billingSubscriptionActivationService.js",
    "src/billing/services/billingScheduledRenewalActivationService.js",
    "src/billing/services/billingPaidLifecycleAtomicService.js",
    "src/billing/services/billingPaidLifecycleService.js",
    "src/billing/services/billingCycleService.js",
    "src/billing/services/billingRenewalEngine.js",
    "src/billing/services/billingSubscriptionCancelService.js",
    "src/billing/services/billingSubscriptionChangePlanService.js",
    "src/billing/services/billingSubscriptionReactivateService.js",
    "src/billing/services/billingSubscriptionService.js", // checkout cria período inicial
    "src/billing/services/billingUsageFallback.js",
    "src/billing/services/billingSuspensionFallbackEntitlementService.js",
    "src/billing/services/billingSellerEntitlementStoreService.js",
    "src/billing/services/billingScheduledDowngradeApplicationService.js",
    "src/billing/services/billingPeriodExpirationService.js",
    "src/billing/services/billingRenewalService.js",
    "src/billing/services/internalBabyPlanService.js",
  ]);
  const forbiddenFieldRe =
    /\b(current_period_start|current_period_end|paid_subscription_status|scheduled_renewal|payment_confirmed_at)\s*:/;
  const dbWriteRe = /\.(update|upsert)\s*\(/;
  const walk = (dir, acc = []) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "migrations") continue;
        walk(p, acc);
      } else if (name.endsWith(".js") && !name.includes(".test.")) {
        acc.push(p);
      }
    }
    return acc;
  };
  const files = walk(path.join(root, "src/billing"));
  /** @type {string[]} */
  const violators = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (allow.has(rel)) continue;
    if (rel.includes("/providers/asaas/") || rel.includes("/routes/")) continue;
    const src = fs.readFileSync(abs, "utf8");
    // Menção em DTO/select sem update/upsert não conta como escrita.
    if (dbWriteRe.test(src) && forbiddenFieldRe.test(src)) violators.push(rel);
  }
  // Entry points de confirmação nunca podem escrever período diretamente.
  const entryPoints = [
    "src/billing/subscriptionStateService.js",
    "src/billing/services/billingPaymentSyncService.js",
    "src/billing/services/billingDunningService.js",
  ];
  for (const ep of entryPoints) {
    const src = read(ep);
    check(
      `2c entry ${path.basename(ep)} no period write`,
      !forbiddenFieldRe.test(src) || !dbWriteRe.test(src) || !/current_period_start\s*:/.test(src),
    );
  }
  check(`2c arch no external cycle writes (${violators.join(",") || "ok"})`, violators.length === 0);
}

// --- 3–6 pending vs confirmed ---
{
  for (const ev of [
    "PAYMENT_CREATED",
    "PAYMENT_PENDING",
    "PIX_CREATED",
    "BOLETO_CREATED",
    "CHECKOUT_OPENED",
    "CARD_TOKENIZED",
    "CARD_PROCESSING",
    "PAYMENT_OVERDUE",
  ]) {
    const c = classifyFinancialPaymentEvent(ev, "PENDING");
    check(`3 pending ${ev}`, c.class === "PENDING" && !c.may_quit_competence);
  }
  check(
    "6 PAYMENT_CONFIRMED quits",
    classifyFinancialPaymentEvent("PAYMENT_CONFIRMED", "CONFIRMED").may_quit_competence,
  );
  check(
    "6b PAYMENT_RECEIVED quits",
    classifyFinancialPaymentEvent("PAYMENT_RECEIVED", "RECEIVED").may_enter_confirm_facade,
  );
  check(
    "5 card processing no quit",
    !classifyFinancialPaymentEvent("CARD_PROCESSING", "PENDING").may_quit_competence,
  );
  check("pending catalog size", BILLING_PENDING_FINANCIAL_EVENTS.length >= 8);
  check("confirmed catalog", BILLING_CONFIRMED_FINANCIAL_EVENTS.includes("PAYMENT_CONFIRMED"));
}

// --- activate gate ---
{
  const denied = await activateSubscriptionFromPaidPayment(
    /** @type {any} */ ({
      from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
    }),
    { source: "rogue", viaCanonicalFacade: false },
  );
  check("activate without facade denied", denied.reason === "ACTIVATE_REQUIRES_CANONICAL_FACADE");
}

// --- 7–8 idempotency / concurrency ---
{
  const sim = simulateMultiInstancePaidClaims({
    userId: "u",
    canonicalSubscriptionId: "sub",
    competenceKey: "sub:2026-08-21:2026-09-21",
    eventType: "PAYMENT_CONFIRMED",
    processCount: 2,
  });
  check("7 duplicate once", sim.unique_ok);
  const race = resolveSuspendVsPaymentRace({
    payment_confirmed: true,
    intended: "SUSPEND",
    metadata: {
      access_owner: "PAYMENT_DELINQUENCY_ENGINE",
      hard_pause_owner: "BABY_QUOTA_ENGINE",
      delinquency_status: "suspended",
    },
  });
  check("27 two instances pay wins", race.apply_reactivate && race.metadata_next.hard_pause_owner === "BABY_QUOTA_ENGINE");
}

// --- 9–10 legacy dunning 3d ---
{
  check("9 dunning days canonical 10", resolveBillingDunningGracePeriodDays() === 10);
  const constants = read("src/billing/billingConstants.js");
  check(
    "9b no default 3 for dunning",
    /BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT\s*=\s*10/.test(constants) &&
      !/BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT\s*=\s*3/.test(constants),
  );
  const overdue = await processBillingOverdues(/** @type {any} */ ({}), {});
  check("9c overdues job disabled", overdue.disabled === true && overdue.legacy_dunning_disabled === true);
  const dunningSrc = read("src/billing/services/billingDunningService.js");
  check(
    "9d no 3-day suspend decision",
    dunningSrc.includes("legacy_3d_dunning: false") &&
      dunningSrc.includes("signal_only") &&
      !dunningSrc.includes("addUtcDays(now, graceDays)"),
  );
  // static scan production billing for dunning literal 3 decision (exclude pre-renewal / trial)
  const dunningFiles = [
    "src/billing/services/billingDunningService.js",
    "src/billing/services/billingRenewalEngine.js",
    "src/billing/services/billingPaidCivilCycleService.js",
  ];
  for (const f of dunningFiles) {
    const src = read(f);
    check(
      `9e no grace=3 in ${path.basename(f)}`,
      !/grace(?:Period|Days|_period)?\s*[:=]\s*3\b/i.test(src) &&
        !/BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT\s*=\s*3/.test(src),
    );
  }
  const d11 = resolveBillingFinancialStateFromDueDate("2026-08-21", "2026-09-01", 10);
  check("10 suspend only D11", d11.billing_financial_state === "SUSPENDED" && d11.suspension_start === "2026-09-01");
  const d10 = resolveBillingFinancialStateFromDueDate("2026-08-21", "2026-08-31", 10);
  check("10b D10 still grace", d10.billing_financial_state === "GRACE_PERIOD");
}

// --- 11–19 Baby reactivation reevaluation ---
{
  const meta = {
    suspension_fallback_active: false,
    effective_entitlement: "PAID_PLAN",
    entitlement_source: "SUBSCRIPTION_ACTIVE",
    hard_pause_owner: BILLING_HARD_PAUSE_OWNER.BABY_QUOTA_ENGINE,
    sync_state: "HARD_PAUSED",
    access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
    usage_billed_count: 60,
    quota_counting_started_at: "2026-09-01T03:00:00.000Z",
    security_access_revoked: true,
  };
  const re = reevaluateBabyQuotaAfterEntitlementChange(meta, {
    effective_entitlement: "PAID_PLAN",
    entitlement_source: "SUBSCRIPTION_ACTIVE",
  });
  check("11-15 baby reeval result", re.result === BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE && re.changed);
  check("16 baby owner cleared", re.metadata.hard_pause_owner == null);
  check("17 orphan baby gone", re.clear_baby_quota_owner === true);
  check("18 baby history preserved", re.metadata.baby_usage_history?.billed_count_at_exit === 60);
  check("19 security preserved", re.metadata.security_access_revoked === true);
  check("20 no forced FULL_ACCESS", re.metadata.access_profile !== BILLING_ACCESS_PROFILE.FULL_ACCESS);
}

// --- 21–23 owners ---
{
  const stillBaby = reevaluateBabyQuotaAfterEntitlementChange({
    suspension_fallback_active: true,
    hard_pause_owner: "BABY_QUOTA_ENGINE",
  });
  check("21 baby still applicable keeps owner", stillBaby.result === "BABY_STILL_APPLICABLE");
  const confirmSrc = read("src/billing/services/billingConfirmCanonicalSubscriptionPaymentService.js");
  check(
    "23 financial clear + baby reeval",
    confirmSrc.includes("clearPaymentDelinquencyOwnerFromMetadata") &&
      confirmSrc.includes("reevaluateBabyQuotaAfterEntitlementChange") &&
      confirmSrc.includes("access_profile_forced: false"),
  );
}

// --- 24 transient convergence ---
{
  const converged = convergePaidLifecycleAfterMutation({
    subscription: {
      id: "sub-1",
      status: "active",
      current_period_start: "2026-09-01T03:00:00.000Z",
      current_period_end: "2026-09-30T03:00:00.000Z",
      next_due_date: "2026-10-01",
      metadata: { delinquency_status: "none", sync_state: "FULL" },
    },
    now: new Date("2026-09-05T15:00:00.000Z"),
    payment_confirmed_for_competence: true,
  });
  check(
    "24 PAID_REACTIVATED converges",
    converged.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE ||
      converged.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE,
  );
  check("24b PAID_REACTIVATED is transient kind", BILLING_PAID_STATE_KIND.PAID_REACTIVATED === "transient_audit");
  check("24c payment pending derived", isPaidLifecycleTransientState(BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING));
}

// --- 25–26 canonical safety ---
{
  const list = [
    {
      id: "hist-active-provider",
      status: "active",
      provider: "asaas",
      created_at: "2026-07-01",
      metadata: { historical_only: true },
    },
    {
      id: "canon-suspended",
      status: "past_due",
      provider: "asaas",
      created_at: "2026-01-01",
      metadata: { canonical_billable: true, delinquency_status: "suspended" },
    },
    {
      id: "canceled-newest",
      status: "canceled",
      provider: "asaas",
      created_at: "2026-07-20",
      metadata: {},
    },
  ];
  const c = resolveCanonicalBillableSubscription(list);
  check("25 historical ACTIVE ignored", c?.id === "canon-suspended");
  const link = classifyPaymentSubscriptionLink(list, "hist-active-provider", "canon-suspended");
  check("26 non-canonical payment reconcile only", link.reconcile_only === true && !link.apply_entitlement);
}

// --- 28 two payment methods same competence (ledger) ---
{
  const a = simulateMultiInstancePaidClaims({
    userId: "u",
    canonicalSubscriptionId: "sub",
    competenceKey: "sub:a:b",
    eventType: "PAYMENT_CONFIRMED",
    processCount: 2,
  });
  check("28 same competence one claim", a.claimed_count === 1);
}

// --- 29–32 non-regression files present + run note ---
{
  check("29 suite 12 present", fs.existsSync(path.join(root, "scripts/test_billing_paid_lifecycle_6_9a12_unit.mjs")));
  check("30 suite 11a present", fs.existsSync(path.join(root, "scripts/test_billing_trial_lifecycle_6_9a11a_unit.mjs")));
  check("31 suite 11 present", fs.existsSync(path.join(root, "scripts/test_billing_trial_lifecycle_6_9a11_unit.mjs")));
  check(
    "32 suite 10 present",
    fs.existsSync(path.join(root, "scripts/test_billing_billable_sale_admission_atomic_6_9a10_static.mjs")) ||
      fs.readdirSync(path.join(root, "scripts")).some((f) => f.includes("6_9a10")),
  );
}

if (failures.length) {
  console.error("FAIL S1.HF.6.9A.12A");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("OK S1.HF.6.9A.12A paid lifecycle runtime wiring");
console.log(`checks_failed=${failures.length}`);
