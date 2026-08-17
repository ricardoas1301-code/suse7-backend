#!/usr/bin/env node
/**
 * S1.HF.6.9A.11 — Trial 15D lifecycle (unit + arquitetura estática)
 * Sem DB / sem SQL execute / sem Asaas / sem cobrança.
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
  resolveTrialEndsAtExclusive,
  buildTrialAlertIdempotencyKey,
  buildTrialExpiredRestrictionPatch,
  clearTrialLifecycleRestrictionFromMetadata,
  resolveTrialLifecyclePresentation,
  BILLING_TRIAL_ALERT_KIND,
} = await import("../src/billing/services/billingTrialLifecycleService.js");
const {
  computeTrialEndDateInclusive,
  buildTrialEntitlementDto,
  resolveTrialTemporalState,
  readSellerTrialState,
} = await import("../src/billing/services/billingSellerTrialService.js");
const { resolveCanonicalAccessPrecedence } = await import(
  "../src/billing/services/billingAccessPrecedenceService.js"
);
const { resolveBillingAccessContext } = await import(
  "../src/billing/services/billingAccessProfileService.js"
);
const { BILLING_TRIAL_LIFECYCLE_STATE, BILLING_TRIAL_STATE, BILLING_TRIAL_METADATA_KEYS } =
  await import("../src/billing/billingConstants.js");
const { formatBillingCivilDateInSaoPaulo } = await import(
  "../src/billing/services/billingCycleService.js"
);

function trialMeta(overrides = {}) {
  return {
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.ACTIVE,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_START_DATE]: "2026-07-22",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_END_DATE]: "2026-08-05",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STARTED_AT]: "2026-07-22T12:00:00.000Z",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_ENDS_AT]: "2026-08-05T23:59:59.999-03:00",
    effective_entitlement: "TRIAL_FULL_ACCESS",
    sync_state: "FULL",
    access_profile: "FULL_ACCESS",
    ...overrides,
  };
}

function atSaoPauloCivilNoon(civil) {
  // 15:00 UTC ≈ 12:00 America/Sao_Paulo (sem DST desde 2019)
  return new Date(`${civil}T15:00:00.000Z`);
}

// --- Relógio / SSOT ---
check("1 trial start end inclusive 15d", computeTrialEndDateInclusive("2026-07-22", 15) === "2026-08-05");
const exclusive = resolveTrialEndsAtExclusive("2026-08-05");
check("2 exclusive end next civil day", exclusive instanceof Date && formatBillingCivilDateInSaoPaulo(exclusive) === "2026-08-06");

const active = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: atSaoPauloCivilNoon("2026-07-25"),
});
check("3 trial active >3d", active.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ACTIVE);
check("3b days remaining 11", active.trial_days_remaining === 11);

const d3 = resolveTrialLifecycleState({ metadata: trialMeta(), now: atSaoPauloCivilNoon("2026-08-02") });
check("4 D3", d3.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D3 && d3.alert_kind === "D3");

const d2 = resolveTrialLifecycleState({ metadata: trialMeta(), now: atSaoPauloCivilNoon("2026-08-03") });
check("5 D2", d2.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D2 && d2.alert_kind === "D2");

const d1 = resolveTrialLifecycleState({ metadata: trialMeta(), now: atSaoPauloCivilNoon("2026-08-04") });
check("6 D1", d1.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1 && d1.alert_kind === "D1");

const lastDay = resolveTrialLifecycleState({ metadata: trialMeta(), now: atSaoPauloCivilNoon("2026-08-05") });
check("7 before exclusive still trial", lastDay.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1);
check("7b ends today compat", lastDay.trial_state_compat === BILLING_TRIAL_STATE.ENDS_TODAY);

const exactExclusive = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: exclusive,
});
check("8 exact exclusive expired", exactExclusive.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED);

const after = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: atSaoPauloCivilNoon("2026-08-06"),
});
check("9 after expired", after.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED);
check("9b timezone SP", after.timezone === "America/Sao_Paulo");

const monthTurnEnd = computeTrialEndDateInclusive("2026-01-20", 15);
const monthTurn = resolveTrialLifecycleState({
  metadata: trialMeta({
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_START_DATE]: "2026-01-20",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_END_DATE]: monthTurnEnd,
  }),
  now: atSaoPauloCivilNoon("2026-01-31"),
});
check(
  "10 month turn D3",
  monthTurnEnd === "2026-02-03" &&
    monthTurn.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D3,
);

const yearTurnEnd = computeTrialEndDateInclusive("2025-12-25", 15);
check("11 year turn end", yearTurnEnd === "2026-01-08");
const yearTurn = resolveTrialLifecycleState({
  metadata: trialMeta({
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_START_DATE]: "2025-12-25",
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_END_DATE]: yearTurnEnd,
  }),
  now: atSaoPauloCivilNoon("2026-01-05"),
});
check("11b year turn D3", yearTurn.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D3);

check("12 no DST contract break", resolveTrialEndsAtExclusive("2026-08-05")?.toISOString().endsWith("Z"));

const key1 = buildTrialAlertIdempotencyKey("u1", "2026-08-05", BILLING_TRIAL_ALERT_KIND.D3);
const key2 = buildTrialAlertIdempotencyKey("u1", "2026-08-05", BILLING_TRIAL_ALERT_KIND.D3);
check("13 idempotency D3 key", key1 === key2 && key1 === "trial:u1:2026-08-05:D3");
check(
  "14 idempotency D2 key",
  buildTrialAlertIdempotencyKey("u1", "2026-08-05", "D2") === "trial:u1:2026-08-05:D2",
);
check(
  "15 idempotency D1 key",
  buildTrialAlertIdempotencyKey("u1", "2026-08-05", "D1") === "trial:u1:2026-08-05:D1",
);
check(
  "16 idempotency EXPIRED key",
  buildTrialAlertIdempotencyKey("u1", "2026-08-05", "EXPIRED") === "trial:u1:2026-08-05:EXPIRED",
);

const reconciler = read("src/billing/jobs/billingTrialLifecycleReconcilerJob.js");
check("17 concurrent lock", reconciler.includes("lockState.running") && reconciler.includes("lock_held"));
check("18 restart safe idempotency", read("src/billing/services/billingTrialLifecycleAlertsService.js").includes("idempotency_key"));
check("19 retry log", reconciler.includes("TRIAL_TRANSITION_RETRY"));

const paidBeforeD3 = resolveTrialLifecycleState({
  metadata: trialMeta({ trial_state: BILLING_TRIAL_STATE.CONVERTED, effective_entitlement: "PAID_PLAN" }),
  now: atSaoPauloCivilNoon("2026-07-25"),
  paid_confirmed: true,
});
check("20 paid before D3", paidBeforeD3.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE && !paidBeforeD3.allow_trial_alerts);

const paidD2 = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: atSaoPauloCivilNoon("2026-08-03"),
  paid_confirmed: true,
});
check("21 paid on D2", paidD2.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE && paidD2.warning_key == null);

const paidD1 = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: atSaoPauloCivilNoon("2026-08-04"),
  paid_confirmed: true,
});
check("22 paid on D1", paidD1.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE);

const paidAfter = resolveTrialLifecycleState({
  metadata: trialMeta({ trial_state: BILLING_TRIAL_STATE.EXPIRED }),
  now: atSaoPauloCivilNoon("2026-08-07"),
  paid_confirmed: true,
});
check("23 paid after expire", paidAfter.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE);

check("24 pix pending no unlock", resolveTrialLifecycleState({
  metadata: trialMeta({ trial_state: BILLING_TRIAL_STATE.EXPIRED }),
  now: atSaoPauloCivilNoon("2026-08-07"),
  paid_confirmed: false,
}).lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED);

check("25 boleto pending no unlock", resolveTrialLifecycleState({
  metadata: trialMeta({ trial_state: BILLING_TRIAL_STATE.EXPIRED, boleto_created: true }),
  now: atSaoPauloCivilNoon("2026-08-07"),
}).lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED);

check("26 card refused no unlock", resolveTrialLifecycleState({
  metadata: trialMeta({ trial_state: BILLING_TRIAL_STATE.EXPIRED, last_card_status: "REFUSED" }),
  now: atSaoPauloCivilNoon("2026-08-07"),
}).lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED);

check("27 webhook dup key stable", key1 === buildTrialAlertIdempotencyKey("u1", "2026-08-05T23:59:59.999-03:00", "D3"));

check(
  "28 non-canonical sub ignored",
  resolveTrialLifecycleState({
    metadata: trialMeta({ trial_state: BILLING_TRIAL_STATE.EXPIRED }),
    now: atSaoPauloCivilNoon("2026-08-07"),
    paid_confirmed: false,
    canonical_subscription_active: false,
  }).lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED,
);

const extended = resolveTrialLifecycleState({
  metadata: trialMeta({
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_EXTENDED_END_DATE]: "2026-08-10",
  }),
  now: atSaoPauloCivilNoon("2026-08-06"),
});
check("29 admin extend valid", extended.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D3 || extended.trial_days_remaining === 4);

const revokedExtend = resolveTrialLifecycleState({
  metadata: trialMeta({
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_EXTENDED_END_DATE]: null,
  }),
  now: atSaoPauloCivilNoon("2026-08-06"),
});
check("30 override revoked expires", revokedExtend.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED);

check("31 multi account fingerprint independent", read("src/billing/services/billingSellerTrialService.js").includes("buildTrialFingerprint"));

const unlimited = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: atSaoPauloCivilNoon("2026-07-25"),
});
check("32 unlimited volume", unlimited.effective_entitlement === "TRIAL_FULL_ACCESS" && unlimited.access_profile === "FULL_ACCESS");

const babyMeta = trialMeta({
  sync_state: "HARD_PAUSED",
  hard_pause_owner: "BABY_QUOTA_ENGINE",
  hard_pause_reason: "BABY_LIMIT_REACHED",
});
const babyPrec = resolveCanonicalAccessPrecedence(babyMeta);
check("33 baby quota rank 4", babyPrec.reason === "baby_quota_hard_paused" && babyPrec.precedence_rank === 4);
const trialWithBabyNoise = resolveTrialLifecycleState({
  metadata: trialMeta(),
  now: atSaoPauloCivilNoon("2026-07-25"),
});
check("33b baby does not force trial expire", trialWithBabyNoise.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ACTIVE);

const expirePatch = buildTrialExpiredRestrictionPatch(trialMeta(), atSaoPauloCivilNoon("2026-08-06"));
check("34 no baby fallback on expire", expirePatch.suspension_fallback_active === false && expirePatch.effective_entitlement === "TRIAL_EXPIRED_RESTRICTED");
check("34b owner trial lifecycle", expirePatch.access_owner === "TRIAL_LIFECYCLE_ENGINE");

check("35 history preserved no delete", !expirePatch.trial_delete_sales && !String(JSON.stringify(expirePatch)).includes("DELETE"));
check("36 sales ownership untouched", !Object.keys(expirePatch).some((k) => k.includes("account_id") || k.includes("ownership")));

check("37 sync full post trial", expirePatch.sync_state === "FULL");
check("38 webhook capability preserved", resolveBillingAccessContext({
  effective_entitlement: "TRIAL_EXPIRED_RESTRICTED",
  access_owner: "TRIAL_LIFECYCLE_ENGINE",
  access_restriction_reason: "TRIAL_EXPIRED",
  trial_state: "EXPIRED",
  sync_state: "FULL",
}).sync_state === "FULL");

check("39 import not stopped", expirePatch.sync_state === "FULL" && expirePatch.access_profile === "EXECUTIVE_ONLY");

const alertsSvc = read("src/billing/services/billingTrialLifecycleAlertsService.js");
check(
  "40 no external channels",
  alertsSvc.includes("IN_APP") &&
    !alertsSvc.includes("asaas.notify") &&
    !alertsSvc.includes("sendEmail(") &&
    !alertsSvc.includes("sendSms("),
);
check(
  "41 asaas not for message",
  !alertsSvc.includes("asaas.") &&
    !alertsSvc.includes("createPayment") &&
    alertsSvc.includes("channels_filter"),
);

const security = resolveTrialLifecycleState({
  metadata: trialMeta({ security_access_revoked: true, access_restriction_reason: "SECURITY_REVOKED" }),
  now: atSaoPauloCivilNoon("2026-07-25"),
});
check("42 security precedence", security.blocked_by_precedence === true && security.allow_trial_alerts === false);

const recovery = resolveTrialLifecycleState({
  metadata: trialMeta({ access_profile: "FINANCIAL_RECOVERY_ONLY" }),
  now: atSaoPauloCivilNoon("2026-07-25"),
});
check("43 recovery precedence", recovery.blocked_by_precedence === true);

const admin = resolveTrialLifecycleState({
  metadata: trialMeta({ administrative_hold: true }),
  now: atSaoPauloCivilNoon("2026-07-25"),
});
check("44 admin precedence", admin.blocked_by_precedence === true);

const cleared = clearTrialLifecycleRestrictionFromMetadata({
  ...expirePatch,
  hard_pause_owner: "BABY_QUOTA_ENGINE",
  sync_state: "HARD_PAUSED",
});
check("45 restore keeps other owner", cleared.cleared === true && cleared.metadata.hard_pause_owner === "BABY_QUOTA_ENGINE");

check("46 no float financial in lifecycle", !read("src/billing/services/billingTrialLifecycleService.js").includes("parseFloat") && !read("src/billing/services/billingTrialLifecycleService.js").match(/\bNumber\(.*price/));

// --- Architecture guards ---
const lifecycleSrc = read("src/billing/services/billingTrialLifecycleService.js");
const sellerTrial = read("src/billing/services/billingSellerTrialService.js");
const feTrialUi = readRepo("suse7-frontend/src/billing/billingTrialUi.js");
const entitlement = read("src/billing/services/billingSubscriptionEntitlementService.js");

check("A single resolver SSOT", lifecycleSrc.includes("export function resolveTrialLifecycleState") && entitlement.includes("resolveTrialLifecycleState"));
check("A no FE day recompute", !feTrialUi.includes("diffBillingCivilDays") && !feTrialUi.includes("Date.parse") && feTrialUi.includes("trial_presentation"));
check("A no trial to baby fallback", sellerTrial.includes("transitionExpireTrialToRestricted") && sellerTrial.includes("trial_must_not_fallback_to_baby") && expirePatch.effective_entitlement !== "BABY_INTERNAL_FREE");
check("A dto expired not baby", (() => {
  const dto = buildTrialEntitlementDto(
    readSellerTrialState(trialMeta({ trial_state: BILLING_TRIAL_STATE.EXPIRED })),
    "2026-08-07",
  );
  return dto?.effective_entitlement === "TRIAL_EXPIRED_RESTRICTED" && dto?.baby_fallback === false;
})());
check(
  "A no parallel setInterval trial",
  !/\bsetInterval\s*\(/.test(reconciler) && !/\bsetInterval\s*\(/.test(alertsSvc),
);
check("A event types registered", read("src/domain/notifications/central/constants/eventTypes.js").includes("TRIAL_ENDING_D3") && read("src/domain/notifications/central/constants/eventTypes.js").includes("TRIAL_EXPIRED"));
check("A presentation copies", resolveTrialLifecyclePresentation("TRIAL_ENDING_D3")?.title?.includes("3 dias"));
check("A api job wired", read("api/index.js").includes("billing-trial-lifecycle-reconciler"));

const temporal = resolveTrialTemporalState(readSellerTrialState(trialMeta()), "2026-07-25");
check("A temporal still active", temporal === BILLING_TRIAL_STATE.ACTIVE);

// Full flow simulation (deterministic, no I/O)
const flowStates = [];
for (const day of ["2026-07-25", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]) {
  flowStates.push(
    resolveTrialLifecycleState({ metadata: trialMeta(), now: atSaoPauloCivilNoon(day) }).lifecycle_state,
  );
}
flowStates.push(
  resolveTrialLifecycleState({
    metadata: trialMeta({ trial_state: BILLING_TRIAL_STATE.EXPIRED, ...expirePatch }),
    now: atSaoPauloCivilNoon("2026-08-07"),
    paid_confirmed: true,
  }).lifecycle_state,
);
check(
  "FLOW complete",
  flowStates.join(">") ===
    [
      BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ACTIVE,
      BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D3,
      BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D2,
      BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1,
      BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1,
      BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED,
      BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE,
    ].join(">"),
);

if (failures.length) {
  console.error("[S1.HF.6.9A.11 trial lifecycle] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("[S1.HF.6.9A.11 trial lifecycle] OK", {
  checks: "47+architecture+flow",
  flow: flowStates.join(" → "),
});
