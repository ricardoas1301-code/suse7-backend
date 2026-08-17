#!/usr/bin/env node
/**
 * S1.HF.6.9A.11A — multi-instance, normalization, EXECUTIVE_ONLY isolation
 * Sem DB / sem SQL execute / sem deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const {
  resolveTrialLifecycleState,
  buildTrialAlertIdempotencyKey,
  clearTrialLifecycleRestrictionFromMetadata,
  buildTrialExpiredRestrictionPatch,
} = await import("../src/billing/services/billingTrialLifecycleService.js");
const {
  normalizeTrialEndsAtExclusive,
  exclusiveInstantFromEndCivil,
} = await import("../src/billing/services/billingTrialEndsAtNormalizationService.js");
const {
  BILLING_TRIAL_TRANSITION_KIND,
  claimTrialLifecycleTransitionLedger,
  simulateMultiInstanceTransitionClaims,
  resolveExpireVsPaidRace,
  buildAlertPersistenceContract,
  alertKindToTransitionKind,
} = await import("../src/billing/services/billingTrialLifecycleAtomicService.js");
const {
  resolveAccessRestrictionCause,
  resolveRecommendedUpgradeCtaFromEntitlement,
  BILLING_RESTRICTION_CAUSE,
} = await import("../src/billing/services/billingAccessRestrictionPresentationService.js");
const { BILLING_TRIAL_LIFECYCLE_STATE, BILLING_TRIAL_METADATA_KEYS, BILLING_TRIAL_STATE } =
  await import("../src/billing/billingConstants.js");
const { computeTrialEndDateInclusive } = await import(
  "../src/billing/services/billingSellerTrialService.js"
);
const { formatBillingCivilDateInSaoPaulo } = await import(
  "../src/billing/services/billingCycleService.js"
);

function trialMeta(overrides = {}) {
  return {
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.ACTIVE,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_START_DATE]: "2026-07-24",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_END_DATE]: "2026-08-07",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STARTED_AT]: "2026-07-24T15:00:00.000Z",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_ENDS_AT]: "2026-08-07T23:59:59.999-03:00",
    effective_entitlement: "TRIAL_FULL_ACCESS",
    sync_state: "FULL",
    access_profile: "FULL_ACCESS",
    ...overrides,
  };
}

function atSpNoon(civil) {
  return new Date(`${civil}T15:00:00.000Z`);
}

// --- Multi-instance ledger (shared Map = DB; sem lock in-process do job) ---
for (const kind of [
  BILLING_TRIAL_TRANSITION_KIND.ALERT_D3,
  BILLING_TRIAL_TRANSITION_KIND.ALERT_D2,
  BILLING_TRIAL_TRANSITION_KIND.ALERT_D1,
  BILLING_TRIAL_TRANSITION_KIND.ALERT_EXPIRED,
]) {
  const sim = simulateMultiInstanceTransitionClaims({
    userId: "11111111-1111-1111-1111-111111111111",
    trialEndCivil: "2026-08-07",
    kind,
    processCount: 2,
  });
  check(`multi ${kind}`, sim.unique_ok && sim.claimed_count === 1 && sim.ledger_size === 1);
}

const cronHttp = simulateMultiInstanceTransitionClaims({
  userId: "22222222-2222-2222-2222-222222222222",
  trialEndCivil: "2026-08-07",
  kind: BILLING_TRIAL_TRANSITION_KIND.EXPIRE_RESTRICTED,
  processCount: 2,
});
check("5 cron×http expire", cronHttp.unique_ok);

/** @type {Map<string, Record<string, unknown>>} */
const ledger = new Map();
const first = claimTrialLifecycleTransitionLedger(ledger, {
  user_id: "u-timeout",
  trial_end_civil: "2026-08-07",
  kind: "ALERT_D3",
});
const retry = claimTrialLifecycleTransitionLedger(ledger, {
  user_id: "u-timeout",
  trial_end_civil: "2026-08-07",
  kind: "ALERT_D3",
});
check("6 retry after ambiguous timeout", first.claimed && retry.idempotent && retry.conflict);
check("7 unique conflict idempotent success", retry.ok && !retry.claimed);

// --- Race expire × paid ---
const metaActive = trialMeta();
const raceA = resolveExpireVsPaidRace({
  paid_confirmed: true,
  metadata: metaActive,
  intended: BILLING_TRIAL_TRANSITION_KIND.EXPIRE_RESTRICTED,
});
check("8/9 payment before expire commit", raceA.winner === "PAID_ACTIVE" && !raceA.apply_expire);

const expiredMeta = {
  ...metaActive,
  ...buildTrialExpiredRestrictionPatch(metaActive, atSpNoon("2026-08-08")),
  hard_pause_owner: "BABY_QUOTA_ENGINE",
  sync_state: "HARD_PAUSED",
};
const raceB = resolveExpireVsPaidRace({
  paid_confirmed: true,
  metadata: expiredMeta,
  intended: BILLING_TRIAL_TRANSITION_KIND.RESTORE_PAID,
});
check(
  "10 payment after expire",
  raceB.winner === "PAID_ACTIVE" &&
    raceB.metadata_next.access_owner == null &&
    raceB.metadata_next.hard_pause_owner === "BABY_QUOTA_ENGINE",
);

const webhookDup = simulateMultiInstanceTransitionClaims({
  userId: "33333333-3333-3333-3333-333333333333",
  trialEndCivil: "2026-08-07",
  kind: BILLING_TRIAL_TRANSITION_KIND.RESTORE_PAID,
  processCount: 3,
});
check("11 webhook dup restore", webhookDup.claimed_count === 1 && webhookDup.idempotent_count === 2);

// --- Normalization ---
const legacy = normalizeTrialEndsAtExclusive({
  trial_ends_at: "2026-08-07T23:59:59.999-03:00",
});
check(
  "12 legacy closed end",
  legacy.ok &&
    legacy.trial_end_date === "2026-08-07" &&
    legacy.trial_ends_at_exclusive_iso === "2026-08-08T03:00:00.000Z",
);

const exclusiveNorm = normalizeTrialEndsAtExclusive({
  trial_ends_at: "2026-08-08T00:00:00-03:00",
});
check(
  "13 exclusive instant",
  exclusiveNorm.ok &&
    exclusiveNorm.trial_end_date === "2026-08-07" &&
    exclusiveNorm.trial_ends_at_exclusive_iso === "2026-08-08T03:00:00.000Z",
);

check("14 start 24/07 end inclusive 07/08", computeTrialEndDateInclusive("2026-07-24", 15) === "2026-08-07");
const exclusive = exclusiveInstantFromEndCivil("2026-08-07");
check(
  "14b exclusive 08/08 00:00 SP",
  exclusive instanceof Date &&
    exclusive.toISOString() === "2026-08-08T03:00:00.000Z" &&
    formatBillingCivilDateInSaoPaulo(exclusive) === "2026-08-08",
);

const beforeExclusive = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: new Date(exclusive.getTime() - 1),
});
check(
  "14c immediately before = D1",
  beforeExclusive.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1,
);
const atExclusive = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: exclusive,
});
check(
  "14d exact exclusive = EXPIRED",
  atExclusive.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED,
);

const month = normalizeTrialEndsAtExclusive({
  trial_start_date: "2026-01-20",
  duration_days: 15,
});
check("15 month turn", month.ok && month.trial_end_date === "2026-02-03");

const year = normalizeTrialEndsAtExclusive({
  trial_start_date: "2025-12-25",
  duration_days: 15,
});
check("16 year turn", year.ok && year.trial_end_date === "2026-01-08");

const invalid = normalizeTrialEndsAtExclusive({ trial_ends_at: "not-a-date", trial_end_date: "xx" });
check("17 invalid fail-closed", !invalid.ok && invalid.trial_ends_at_exclusive == null);

const failClosedLifecycle = resolveTrialLifecycleState({
  metadata: {
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.ACTIVE,
  },
  now: atSpNoon("2026-07-25"),
});
check("17b resolver fail-closed", failClosedLifecycle.fail_closed === true);

// Domain must not use legacy trial_ends_at as exclusive fallback
check(
  "domain exclusive only",
  atExclusive.trial_ends_at_exclusive === "2026-08-08T03:00:00.000Z" &&
    !String(atExclusive.trial_ends_at_exclusive).includes("23:59:59"),
);

// --- EXECUTIVE_ONLY isolation ---
const trialCause = resolveAccessRestrictionCause({
  access_profile: "EXECUTIVE_ONLY",
  access_restriction_reason: "TRIAL_EXPIRED",
  access_owner: "TRIAL_LIFECYCLE_ENGINE",
  effective_entitlement: "TRIAL_EXPIRED_RESTRICTED",
});
check("18 EXECUTIVE_ONLY trial cause", trialCause.cause === BILLING_RESTRICTION_CAUSE.TRIAL_EXPIRED);

const usageCause = resolveAccessRestrictionCause({
  access_profile: "EXECUTIVE_ONLY",
  usage_state: "LIMIT_RESTRICTED",
  effective_entitlement: "PAID_PLAN",
});
check("19 EXECUTIVE_ONLY usage cause", usageCause.cause === BILLING_RESTRICTION_CAUSE.PAID_USAGE_LIMIT);

const trialCta = resolveRecommendedUpgradeCtaFromEntitlement({
  access_profile: "EXECUTIVE_ONLY",
  access_restriction_reason: "TRIAL_EXPIRED",
  access_owner: "TRIAL_LIFECYCLE_ENGINE",
  effective_entitlement: "TRIAL_EXPIRED_RESTRICTED",
});
const usageCta = resolveRecommendedUpgradeCtaFromEntitlement({
  access_profile: "EXECUTIVE_ONLY",
  usage_state: "LIMIT_RESTRICTED",
  effective_entitlement: "PAID_PLAN",
});
const babyCta = resolveRecommendedUpgradeCtaFromEntitlement({
  access_profile: "ARCHIVE_READ_ONLY",
  access_owner: "BABY_QUOTA_ENGINE",
  effective_entitlement: "BABY_INTERNAL_FREE",
  sync_state: "HARD_PAUSED",
  hard_pause_owner: "BABY_QUOTA_ENGINE",
});
check(
  "20 no cross copy",
  trialCta.cause === "TRIAL_EXPIRED" &&
    !String(trialCta.message ?? "").toLowerCase().includes("baby") &&
    !String(trialCta.message ?? "").toLowerCase().includes("limite do plano atingido") &&
    usageCta.cause === "PAID_USAGE_LIMIT" &&
    !String(usageCta.message ?? "").includes("teste") &&
    babyCta.cause === "BABY_QUOTA",
);

const cleared = clearTrialLifecycleRestrictionFromMetadata(expiredMeta);
check(
  "21 other owner preserved",
  cleared.cleared && cleared.metadata.hard_pause_owner === "BABY_QUOTA_ENGINE",
);

// Persistence contract
const contract = buildAlertPersistenceContract("user-1", "2026-08-07", "D3");
check(
  "persist contract",
  contract.table === "s7_notification_events" &&
    contract.unique_index === "s7_notification_events_seller_idempotency_uq" &&
    contract.idempotency_key === "trial:user-1:2026-08-07:D3" &&
    contract.transition_ledger_table === "billing_trial_lifecycle_transitions" &&
    contract.transition_kind === alertKindToTransitionKind("D3"),
);

// Architecture: in-process not primary; migration prepared
const migration = read(
  "supabase/migrations/20260724150000_s7_billing_trial_lifecycle_atomic_6_9a11a.sql",
);
const reconciler = read("src/billing/jobs/billingTrialLifecycleReconcilerJob.js");
const atomicSvc = read("src/billing/services/billingTrialLifecycleAtomicService.js");
const insertEvt = read("src/domain/notifications/central/events/insertCentralNotificationEvent.js");
check(
  "A migration ledger unique",
  migration.includes("billing_trial_lifecycle_transitions_uq") &&
    migration.includes("TRIAL_ENDING_D3") &&
    migration.includes("pg_advisory_xact_lock"),
);
check(
  "A distributed lock primary",
  reconciler.includes("distributed_lock_held") &&
    reconciler.includes("tryAcquireTrialLifecycleJobLock") &&
    reconciler.includes("Otimização local"),
);
check("A notification unique 23505", insertEvt.includes("23505") && insertEvt.includes("idempotent"));
check("A no setInterval primary", !/\bsetInterval\s*\(/.test(atomicSvc));
check(
  "A FE cause helper",
  readRepo("suse7-frontend/src/billing/billingEntitlementCapabilities.js").includes(
    "resolveRestrictionCause",
  ),
);
check(
  "A CTA not profile-only",
  read("src/billing/services/billingAccessProfileService.js").includes("cause: \"UNKNOWN\"") &&
    read("src/billing/services/billingAccessRestrictionPresentationService.js").includes(
      "TRIAL_EXPIRED",
    ),
);

// Civil-only input
const civilOnly = normalizeTrialEndsAtExclusive({ trial_end_date: "2026-08-07" });
check("civil only", civilOnly.ok && civilOnly.trial_ends_at_exclusive_iso === "2026-08-08T03:00:00.000Z");

// UTC → SP
const utcInput = normalizeTrialEndsAtExclusive({
  trial_started_at: "2026-07-24T03:00:00.000Z",
  duration_days: 15,
});
check("utc to SP start", utcInput.ok && utcInput.trial_end_date === "2026-08-07");

if (failures.length) {
  console.error("[S1.HF.6.9A.11A] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("[S1.HF.6.9A.11A] OK", { checks: failures.length === 0 ? "23+architecture" : 0 });
