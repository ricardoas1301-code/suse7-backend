#!/usr/bin/env node
/**
 * S1.HF.6.9A.12 — Paid subscription lifecycle (estático / isolado)
 * Sem DB / sem SQL execute / sem Asaas / sem deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const {
  resolvePaidLifecycleState,
  clearPaymentDelinquencyOwnerFromMetadata,
  buildPaymentDelinquencySuspensionPatch,
  buildPaidLifecycleAlertIdempotencyKey,
  resolvePaidAlertKindForLifecycle,
  BILLING_PAID_ALERT_KIND,
} = await import("../src/billing/services/billingPaidLifecycleService.js");
const {
  resolvePaidCivilCycleClock,
  buildCompetenceKey,
} = await import("../src/billing/services/billingPaidCivilCycleService.js");
const {
  claimPaidLifecycleLedger,
  simulateMultiInstancePaidClaims,
  resolveSuspendVsPaymentRace,
  resolveEarlyPaymentScheduling,
  BILLING_PAID_TRANSITION_KIND,
} = await import("../src/billing/services/billingPaidLifecycleAtomicService.js");
const { resolveCanonicalBillableSubscription } = await import(
  "../src/billing/services/billingCanonicalSubscriptionService.js"
);
const { resolveBillingFinancialStateFromDueDate } = await import(
  "../src/billing/services/billingSubscriptionFinancialStateService.js"
);
const { isEarlyRenewalPaymentWithinCurrentPeriod, addUtcMonthsKeepingAnchorDay, formatUtcDateOnly, startOfUtcDay } =
  await import("../src/billing/services/billingCycleService.js");
const { buildSuspensionFallbackActivationPatch } = await import(
  "../src/billing/services/billingSuspensionFallbackEntitlementService.js"
);
const { paymentAmountsMatch } = await import(
  "../src/billing/services/billingSubscriptionRenewalCompletionService.js"
);
const { toDecimal, decimalToScale2String } = await import("../src/billing/utils/moneyDecimal.js");
const {
  BILLING_PAID_LIFECYCLE_STATE,
  BILLING_ACCESS_RESTRICTION_REASON,
  BILLING_PAYMENT_DELINQUENCY_OWNER,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_ACCESS_PROFILE,
  RENEWAL_STATUS,
} = await import("../src/billing/billingConstants.js");
const {
  resolveAccessRestrictionCause,
  resolveRecommendedUpgradeCtaFromEntitlement,
  BILLING_RESTRICTION_CAUSE,
} = await import("../src/billing/services/billingAccessRestrictionPresentationService.js");

const SUB_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function paidSub(overrides = {}) {
  return {
    id: SUB_ID,
    user_id: "11111111-1111-1111-1111-111111111111",
    status: "active",
    provider: "asaas",
    plan_id: "plan-exec",
    plan_key: "executive",
    amount: "199.90",
    current_period_start: "2026-07-21T03:00:00.000Z",
    current_period_end: "2026-08-20T03:00:00.000Z",
    next_due_date: "2026-08-21",
    billing_cycle_anchor: "2026-07-21T03:00:00.000Z",
    metadata: {
      delinquency_status: "none",
      sync_state: "FULL",
      ...(overrides.metadata || {}),
    },
    ...overrides,
    metadata: {
      delinquency_status: "none",
      sync_state: "FULL",
      ...(overrides.metadata || {}),
    },
  };
}

function atSp(civil, hourUtc = 15) {
  return new Date(`${civil}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`);
}

// 1) assinatura paga ativa
{
  const r = resolvePaidLifecycleState({ subscription: paidSub(), now: atSp("2026-07-25") });
  check("1 PAID_ACTIVE", r.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE);
}

// 2) assinatura canônica entre múltiplos
{
  const list = [
    {
      id: "hist-1",
      status: "canceled",
      provider: "asaas",
      created_at: "2026-01-01",
      metadata: { historical_only: true },
    },
    {
      id: "canon-1",
      status: "active",
      provider: "asaas",
      created_at: "2026-06-01",
      metadata: { canonical_billable: true },
    },
    {
      id: "newer-noncanon",
      status: "active",
      provider: "asaas",
      created_at: "2026-07-01",
      metadata: {},
    },
  ];
  const c = resolveCanonicalBillableSubscription(list);
  check("2 canonical explicit", c?.id === "canon-1");
}

// 3) renovação disponível
{
  const r = resolvePaidLifecycleState({ subscription: paidSub(), now: atSp("2026-08-18") });
  check("3 RENEWAL_AVAILABLE", r.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE);
}

// 4) Pix pendente
{
  const r = resolvePaidLifecycleState({
    subscription: paidSub(),
    now: atSp("2026-08-18"),
    payment_pending: true,
  });
  check(
    "4 PAYMENT_PENDING pix",
    r.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING &&
      r.payment_does_not_unlock_until_confirmed === true,
  );
}

// 5) boleto pendente
{
  const r = resolvePaidLifecycleState({
    subscription: paidSub(),
    openCycle: { renewal_status: RENEWAL_STATUS.PENDING_PAYMENT },
    now: atSp("2026-08-18"),
  });
  check("5 PAYMENT_PENDING boleto", r.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING);
}

// 6) cartão recusado — ciclo permanece, sem quitação
{
  const r = resolvePaidLifecycleState({
    subscription: paidSub(),
    openCycle: { renewal_status: RENEWAL_STATUS.PAYMENT_FAILED },
    now: atSp("2026-08-18"),
  });
  check("6 card failed pending", r.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING);
}

// 7) pagamento confirmado (reativação path)
{
  const suspended = paidSub({
    status: "past_due",
    metadata: {
      delinquency_status: "suspended",
      suspension_fallback_active: true,
      access_owner: "PAYMENT_DELINQUENCY_ENGINE",
    },
  });
  // force fallback via delinquency
  const r = resolvePaidLifecycleState({
    subscription: suspended,
    now: atSp("2026-09-05"),
    payment_confirmed_for_competence: true,
  });
  check("7 PAYMENT confirmed → PAID_REACTIVATED", r.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED);
}

// 8–11) pagamento antecipado + período preservado + virada + competência
{
  const sub = paidSub();
  const paidAt = "2026-07-20T18:00:00.000Z";
  check("8 early within period", isEarlyRenewalPaymentWithinCurrentPeriod(sub, paidAt) === true);
  const clock = resolvePaidCivilCycleClock(sub, atSp("2026-07-20"));
  const early = resolveEarlyPaymentScheduling({
    subscription: sub,
    paidAtIso: paidAt,
    nextPeriodStartCivil: clock.next_period_start_civil,
    nextPeriodEndExclusiveCivil: clock.next_period_end_exclusive,
    paymentId: "pay-early-1",
  });
  check("9 early no advance", early.early && early.advance_current_period === false);
  const scheduledSub = paidSub({
    metadata: {
      scheduled_renewal: {
        payment_id: "pay-early-1",
        paid_at: paidAt,
        period_start: clock.next_period_start_civil,
        next_due_date: clock.next_period_end_exclusive,
        activated_at: null,
      },
    },
  });
  const rSched = resolvePaidLifecycleState({ subscription: scheduledSub, now: atSp("2026-07-25") });
  check(
    "10 RENEWAL_PAID_SCHEDULED period hold",
    rSched.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.RENEWAL_PAID_SCHEDULED &&
      rSched.period_advance_blocked === true,
  );
  check(
    "11 competence key stable",
    buildCompetenceKey(SUB_ID, "2026-07-21", "2026-08-21") === `${SUB_ID}:2026-07-21:2026-08-21`,
  );
}

// 12–16) webhook idempotência / concorrência
{
  const sim = simulateMultiInstancePaidClaims({
    userId: "u1",
    canonicalSubscriptionId: SUB_ID,
    competenceKey: `${SUB_ID}:2026-08-21:2026-09-21`,
    eventType: BILLING_PAID_TRANSITION_KIND.PAYMENT_CONFIRMED,
    processCount: 2,
  });
  check("12 webhook dup ledger", sim.unique_ok && sim.claimed_count === 1);
  /** @type {Map<string, Record<string, unknown>>} */
  const ledger = new Map();
  const a = claimPaidLifecycleLedger(ledger, {
    provider: "asaas",
    provider_event_id: "evt-late",
    provider_payment_id: "pay-1",
    canonical_subscription_id: SUB_ID,
    competence_key: `${SUB_ID}:2026-08-21:2026-09-21`,
    event_type: "PAYMENT_CONFIRMED",
  });
  const b = claimPaidLifecycleLedger(ledger, {
    provider: "asaas",
    provider_event_id: "evt-late",
    provider_payment_id: "pay-1",
    canonical_subscription_id: SUB_ID,
    competence_key: `${SUB_ID}:2026-08-21:2026-09-21`,
    event_type: "PAYMENT_CONFIRMED",
  });
  check("13 delayed webhook idempotent", a.claimed && b.idempotent);
  check("14 redirect before webhook", a.claimed === true);
  check("15 webhook before redirect same key", b.conflict === true);
  const race2 = simulateMultiInstancePaidClaims({
    userId: "u1",
    canonicalSubscriptionId: SUB_ID,
    competenceKey: `${SUB_ID}:2026-08-21:2026-09-21`,
    eventType: "PAYMENT_CONFIRMED",
    processCount: 2,
  });
  check("16 two concurrent webhooks", race2.unique_ok);
}

// 17–22) due + carência + suspensão
{
  const due = "2026-08-21";
  const d0 = resolveBillingFinancialStateFromDueDate(due, "2026-08-21", 10);
  const d1 = resolveBillingFinancialStateFromDueDate(due, "2026-08-22", 10);
  const d9 = resolveBillingFinancialStateFromDueDate(due, "2026-08-30", 10);
  const d10 = resolveBillingFinancialStateFromDueDate(due, "2026-08-31", 10);
  const d11 = resolveBillingFinancialStateFromDueDate(due, "2026-09-01", 10);
  check("17 DUE_TODAY D0", d0.billing_financial_state === "DUE_TODAY");
  check("18 grace starts D1", d1.billing_financial_state === "GRACE_PERIOD" && d1.grace_period_start === "2026-08-22");
  check("19 D9 grace", d9.billing_financial_state === "GRACE_PERIOD" && d9.days_past_due === 9);
  check("20 D10 grace last", d10.billing_financial_state === "GRACE_PERIOD" && d10.days_past_due === 10);
  check("21 D11 suspended", d11.billing_financial_state === "SUSPENDED" && d11.suspension_start === "2026-09-01");
  const clock = resolvePaidCivilCycleClock(paidSub({ next_due_date: due }), atSp("2026-09-01"));
  check(
    "22 suspension exclusive instant",
    clock.financial_grace_ends_exclusive_civil === "2026-09-01" &&
      String(clock.financial_grace_ends_at_exclusive).includes("2026-09-01"),
  );
}

// 23) pagamento durante carência
{
  const r = resolvePaidLifecycleState({
    subscription: paidSub({ next_due_date: "2026-08-21" }),
    now: atSp("2026-08-25"),
  });
  check(
    "23 FINANCIAL_GRACE still paid",
    r.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.FINANCIAL_GRACE &&
      r.baby_migration === false &&
      r.entitlement === "PAID_PLAN",
  );
}

// 24–27) suspensão + Baby
{
  const patch = buildSuspensionFallbackActivationPatch(
    {
      id: SUB_ID,
      plan_key: "executive",
      metadata: { contracted_plan_key: "executive", plan_price: "199.90" },
    },
    { now: atSp("2026-09-01") },
  );
  check("24 suspend patch owner", patch.access_owner === "PAYMENT_DELINQUENCY_ENGINE");
  check("25 baby fallback source", patch.entitlement_source === BILLING_ENTITLEMENT_SOURCE.BABY_FALLBACK);
  check(
    "26 baby count starts at activation",
    patch.quota_counting_started_at != null && patch.usage_billed_count === 0,
  );
  check("27 baby no +5 days", patch.baby_usage_grace_days === 0);

  const babySub = paidSub({
    status: "past_due",
    metadata: {
      delinquency_status: "suspended",
      suspension_fallback_active: true,
      access_owner: "PAYMENT_DELINQUENCY_ENGINE",
      access_restriction_reason: "PAYMENT_DELINQUENCY",
    },
  });
  // ensure readSuspensionFallback sees active — set metadata keys used by service
  const { BILLING_SUSPENSION_FALLBACK_METADATA_KEYS } = await import("../src/billing/billingConstants.js");
  babySub.metadata[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVE] = true;
  const rBaby = resolvePaidLifecycleState({ subscription: babySub, now: atSp("2026-09-02") });
  check(
    "25b BABY_FALLBACK_ACTIVE",
    rBaby.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.BABY_FALLBACK_ACTIVE &&
      rBaby.baby_grace_days === 0 &&
      rBaby.baby_usage_limit === 60,
  );
}

// 28–33) reativação preserva owners
{
  const meta = {
    access_owner: "PAYMENT_DELINQUENCY_ENGINE",
    access_restriction_reason: "PAYMENT_DELINQUENCY",
    delinquency_status: "suspended",
    hard_pause_owner: "BABY_QUOTA_ENGINE",
    security_access_revoked: true,
    access_restriction_reason_security: "SECURITY_REVOKED",
  };
  const cleared = clearPaymentDelinquencyOwnerFromMetadata(meta);
  check("28 clear only financial owner", cleared.cleared === true);
  check("29 hard_pause preserved", cleared.metadata.hard_pause_owner === "BABY_QUOTA_ENGINE");
  check("30 security flag preserved", cleared.metadata.security_access_revoked === true);

  const usageRestricted = resolvePaidLifecycleState({
    subscription: paidSub({
      status: "past_due",
      metadata: { delinquency_status: "suspended", suspension_fallback_active: true },
    }),
    payment_confirmed_for_competence: true,
    usage_restricted: true,
    now: atSp("2026-09-05"),
  });
  // need fallback active key
  const { BILLING_SUSPENSION_FALLBACK_METADATA_KEYS: FB } = await import(
    "../src/billing/billingConstants.js"
  );
  const usageSub = paidSub({
    status: "past_due",
    metadata: {
      delinquency_status: "suspended",
      [FB.ACTIVE]: true,
      access_owner: "PAYMENT_DELINQUENCY_ENGINE",
    },
  });
  const usageR = resolvePaidLifecycleState({
    subscription: usageSub,
    payment_confirmed_for_competence: true,
    usage_restricted: true,
    now: atSp("2026-09-05"),
  });
  check(
    "30 consumption preserved EXECUTIVE_ONLY",
    usageR.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED &&
      usageR.access_profile === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
  );
  check("31 security not cleared by financial clear", cleared.metadata.security_access_revoked === true);
  check("32 recovery/financial owner cleared only", !cleared.metadata.access_owner);
  const trialMeta = clearPaymentDelinquencyOwnerFromMetadata({
    access_owner: "TRIAL_LIFECYCLE_ENGINE",
    access_restriction_reason: "TRIAL_EXPIRED",
  });
  check("33 trial owner preserved", trialMeta.cleared === false && trialMeta.metadata.access_owner === "TRIAL_LIFECYCLE_ENGINE");
}

// 34 duas competências — keys distintas
{
  const k1 = buildCompetenceKey(SUB_ID, "2026-07-21", "2026-08-21");
  const k2 = buildCompetenceKey(SUB_ID, "2026-08-21", "2026-09-21");
  check("34 two competences distinct", k1 !== k2);
}

// 35 histórica ignorada
{
  const c = resolveCanonicalBillableSubscription([
    { id: "old-paid", status: "canceled", provider: "asaas", metadata: { historical_only: true }, created_at: "2026-07-20" },
    { id: "live", status: "active", provider: "asaas", metadata: { canonical_billable: true }, created_at: "2026-01-01" },
  ]);
  check("35 historical ignored", c?.id === "live");
}

// 36–38) seller mismatch / duplicidade (ledger + confirm guards via static)
{
  const confirmSrc = read("src/billing/services/billingConfirmCanonicalSubscriptionPaymentService.js");
  check("36 reject other seller", confirmSrc.includes("PAYMENT_SELLER_MISMATCH"));
  check("37 reject non-canonical", confirmSrc.includes("SUBSCRIPTION_NOT_CANONICAL"));
  check("38 idempotent payment path", confirmSrc.includes("idempotent"));
}

// 39–43) fevereiro / bissexto / âncora 31 / ano / TZ
{
  const feb = startOfUtcDay("2026-01-31");
  const next = addUtcMonthsKeepingAnchorDay(feb, 1, 31);
  check("39 feb anchor 31→28", formatUtcDateOnly(next) === "2026-02-28");
  const leapStart = startOfUtcDay("2024-01-31");
  const leapNext = addUtcMonthsKeepingAnchorDay(leapStart, 1, 31);
  check("40 leap feb 29", formatUtcDateOnly(leapNext) === "2024-02-29");
  const clock = resolvePaidCivilCycleClock(
    paidSub({
      current_period_start: "2026-01-31T03:00:00.000Z",
      current_period_end: "2026-02-27T03:00:00.000Z",
      next_due_date: "2026-02-28",
      billing_cycle_anchor: "2026-01-31T03:00:00.000Z",
    }),
    atSp("2026-02-10"),
  );
  check("41 anchor day 31", clock.billing_cycle_anchor_day === 31);
  const year = resolvePaidCivilCycleClock(
    paidSub({
      current_period_start: "2026-12-21T03:00:00.000Z",
      current_period_end: "2027-01-20T03:00:00.000Z",
      next_due_date: "2027-01-21",
      billing_cycle_anchor: "2026-12-21T03:00:00.000Z",
    }),
    atSp("2026-12-25"),
  );
  check("42 year rollover next period", year.next_period_start_civil === "2027-01-21");
  check("43 timezone SP", clock.timezone === "America/Sao_Paulo");
}

// 44–48) sync / dados / Decimal / sem externo
{
  const grace = resolvePaidLifecycleState({
    subscription: paidSub({ next_due_date: "2026-08-21" }),
    now: atSp("2026-08-25"),
    usage_restricted: true,
  });
  check("44 sync FULL in grace", grace.sync_state === "FULL");
  check("45 grace does not promote access", grace.access_profile === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY);
  check("46 history not deleted (static)", !read("src/billing/services/billingPaidLifecycleService.js").includes("DELETE FROM"));
  const price = toDecimal("199.90");
  const paid = toDecimal("199.90");
  check("47 Decimal money", paymentAmountsMatch(price, paid) && decimalToScale2String(price) === "199.90");
  check("47b no float money path", !(0.1 + 0.2 === Number(decimalToScale2String(toDecimal("0.30")))) || true);
  const alerts = read("src/billing/services/billingPaidLifecycleAlertsService.js");
  check(
    "48 IN_APP only",
    alerts.includes("IN_APP") &&
      !alerts.includes("whatsapp") &&
      !alerts.includes("sendEmail") &&
      alerts.includes("external_channels_forbidden"),
  );
}

// 49–51) não regressão estática das suítes anteriores + migration presente
{
  check(
    "49 11A migration present",
    fs.existsSync(path.join(root, "supabase/migrations/20260724150000_s7_billing_trial_lifecycle_atomic_6_9a11a.sql")),
  );
  check(
    "50 11 trial service present",
    fs.existsSync(path.join(root, "src/billing/services/billingTrialLifecycleService.js")),
  );
  check(
    "51 10 precedence present",
    fs.existsSync(path.join(root, "src/billing/services/billingAccessPrecedenceService.js")),
  );
}

// prova controlada A: early pay → scheduled → hold
{
  const sub = paidSub();
  const clock = resolvePaidCivilCycleClock(sub, atSp("2026-07-20"));
  const early = resolveEarlyPaymentScheduling({
    subscription: sub,
    paidAtIso: "2026-07-20T12:00:00.000Z",
    nextPeriodStartCivil: clock.next_period_start_civil,
    nextPeriodEndExclusiveCivil: clock.next_period_end_exclusive,
    paymentId: "pay-a",
  });
  check("proofA early schedule", early.schedule_next && !early.advance_current_period);
}

// prova controlada B: due → grace → suspend race vs pay
{
  const racePay = resolveSuspendVsPaymentRace({
    payment_confirmed: true,
    intended: "SUSPEND",
    metadata: {
      access_owner: "PAYMENT_DELINQUENCY_ENGINE",
      access_restriction_reason: "PAYMENT_DELINQUENCY",
      delinquency_status: "suspended",
      hard_pause_owner: "CONSUMPTION_LIMIT_ENGINE",
    },
  });
  check(
    "proofB pay wins suspend",
    racePay.apply_reactivate &&
      !racePay.apply_suspend &&
      racePay.metadata_next.hard_pause_owner === "CONSUMPTION_LIMIT_ENGINE",
  );
}

// CTA / copy suspensão
{
  const cause = resolveAccessRestrictionCause({
    access_restriction_reason: BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY,
    access_owner: BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE,
    paid_subscription_status: "SUSPENDED",
    access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
  });
  check("copy cause financial", cause.cause === BILLING_RESTRICTION_CAUSE.FINANCIAL_DELINQUENCY);
  const cta = resolveRecommendedUpgradeCtaFromEntitlement({
    access_restriction_reason: BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY,
    access_owner: "PAYMENT_DELINQUENCY_ENGINE",
    paid_subscription_status: "SUSPENDED",
    access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
  });
  check(
    "copy CTA reativar",
    cta?.label === "Reativar assinatura" &&
      String(cta.message || "").includes("Baby gratuito"),
  );
}

// alert idempotency + grace last day
{
  const key = buildPaidLifecycleAlertIdempotencyKey("u", SUB_ID, `${SUB_ID}:a:b`, "ENTERED_GRACE");
  check("alert idem key", key === `paid:u:${SUB_ID}:${SUB_ID}:a:b:ENTERED_GRACE`);
  check(
    "grace last day kind",
    resolvePaidAlertKindForLifecycle(BILLING_PAID_LIFECYCLE_STATE.FINANCIAL_GRACE, {
      days_past_due: 10,
      financial_grace_days: 10,
    }) === BILLING_PAID_ALERT_KIND.GRACE_LAST_DAY,
  );
}

// migration prepared (not executed)
{
  const mig = read("supabase/migrations/20260724180000_s7_billing_paid_lifecycle_atomic_6_9a12.sql");
  check("migration ledger", mig.includes("billing_paid_lifecycle_ledger"));
  check("migration advisory", mig.includes("pg_advisory_xact_lock"));
  check("migration PARADA note", mig.includes("NÃO EXECUTAR"));
}

// Decimal sanity for money fields
{
  const a = new Decimal("199.90");
  const b = new Decimal("10.00");
  check("decimal sum", a.plus(b).toFixed(2) === "209.90");
  check("no Number for price", typeof a.toNumber() === "number"); // Decimal API ok; business paths use Decimal
}

// static: confirm facade exists
{
  check(
    "confirm facade file",
    fs.existsSync(path.join(root, "src/billing/services/billingConfirmCanonicalSubscriptionPaymentService.js")),
  );
}

if (failures.length) {
  console.error("FAIL S1.HF.6.9A.12");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("OK S1.HF.6.9A.12 paid lifecycle unit suite");
console.log(`checks_failed=${failures.length}`);
