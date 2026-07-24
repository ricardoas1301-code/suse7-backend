// ======================================================================
// Elegibilidade de franquia vs trial/histórico (S1.HF.6.9A.10)
// Data oficial = date_created; ciclo civil SP semiaberto.
// ======================================================================

import {
  BILLING_SALE_PERIOD_CLASS,
  BILLING_SNAPSHOT_ORIGIN,
  BILLING_TRIAL_METADATA_KEYS,
  BILLING_TRIAL_STATE,
} from "../billingConstants.js";
import { readSellerTrialState, resolveTrialTemporalState } from "./billingSellerTrialService.js";
import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";
import {
  isOfficialOrderInCycleWindow,
  resolveCurrentBabyCycleWindow,
} from "./billingCivilCycleWindowService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 */
export function parseIsoTimestamp(value) {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * @param {unknown} value
 */
export function normalizeBillingSnapshotOrigin(value) {
  const raw = asTrimmedString(value);
  if (!raw) return BILLING_SNAPSHOT_ORIGIN.UNKNOWN;
  const allowed = new Set(Object.values(BILLING_SNAPSHOT_ORIGIN));
  if (allowed.has(/** @type {any} */ (raw))) return raw;
  if (raw === "post_suse7_sale") return BILLING_SNAPSHOT_ORIGIN.UNKNOWN;
  return BILLING_SNAPSHOT_ORIGIN.UNKNOWN;
}

/**
 * @param {string | null | undefined} trialState
 */
export function isTrialTemporallyActiveState(trialState) {
  const s = String(trialState ?? "");
  return (
    s === BILLING_TRIAL_STATE.ACTIVE ||
    s === BILLING_TRIAL_STATE.ENDING_SOON ||
    s === BILLING_TRIAL_STATE.ENDS_TODAY
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 * @param {Date} [now]
 */
export function resolveTrialTemporalFromMetadata(metadata, now = new Date()) {
  const trial = readSellerTrialState(metadata);
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const temporal = resolveTrialTemporalState(trial, civilNow);
  return { trial, temporal, active: isTrialTemporallyActiveState(temporal) };
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function readOperationalCutoverAt(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return parseIsoTimestamp(meta[BILLING_TRIAL_METADATA_KEYS.OPERATIONAL_CUTOVER_AT]);
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function readQuotaCountingStartedAt(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return parseIsoTimestamp(meta[BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]);
}

/**
 * Somente date_created oficial — nunca date_closed / created_at / inserted_at.
 *
 * @param {{
 *   date_created_marketplace?: unknown;
 *   official_order_at?: unknown;
 *   date_created?: unknown;
 * }} order
 */
export function resolveOfficialOrderAt(order) {
  return (
    parseIsoTimestamp(order?.date_created_marketplace) ??
    parseIsoTimestamp(order?.official_order_at) ??
    parseIsoTimestamp(order?.date_created)
  );
}

/**
 * @param {unknown} snapshotOrigin
 */
export function isOnboardingImportOrigin(snapshotOrigin) {
  return normalizeBillingSnapshotOrigin(snapshotOrigin) === BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT;
}

/**
 * @param {{
 *   metadata?: Record<string, unknown> | null;
 *   official_order_at?: Date | null;
 *   snapshot_origin?: string | null;
 *   now?: Date;
 * }} input
 */
export function classifySalePeriodForQuota(input) {
  const origin = normalizeBillingSnapshotOrigin(input.snapshot_origin);

  if (origin === BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT) {
    return {
      class: BILLING_SALE_PERIOD_CLASS.IMPORTACAO_HISTORICA,
      quota_eligible: false,
      reason: "onboarding_import",
      snapshot_origin: origin,
    };
  }

  const { temporal, active } = resolveTrialTemporalFromMetadata(input.metadata, input.now);
  const cutover = readOperationalCutoverAt(input.metadata);
  const quotaStart = readQuotaCountingStartedAt(input.metadata);
  const official = input.official_order_at instanceof Date ? input.official_order_at : null;

  if (!official) {
    if (quotaStart || !active) {
      return {
        class: BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW,
        quota_eligible: false,
        reason: "official_order_at_missing",
        snapshot_origin: origin,
        manual_review_required: true,
      };
    }
    return {
      class: BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW,
      quota_eligible: false,
      reason: "official_order_at_missing",
      snapshot_origin: origin,
      manual_review_required: true,
    };
  }

  if (cutover && official < cutover) {
    return {
      class: BILLING_SALE_PERIOD_CLASS.PRE_OPERATIONAL_CUTOVER,
      quota_eligible: false,
      reason: "before_operational_cutover",
      snapshot_origin: origin,
      official_order_at: official.toISOString(),
    };
  }

  if (active) {
    return {
      class: BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO,
      quota_eligible: false,
      reason: "trial_active_unlimited",
      trial_state: temporal,
      snapshot_origin: origin,
      official_order_at: official.toISOString(),
    };
  }

  if (!quotaStart) {
    return {
      class: BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW,
      quota_eligible: false,
      reason: "quota_counting_started_at_missing",
      snapshot_origin: origin,
      official_order_at: official.toISOString(),
      manual_review_required: true,
    };
  }

  if (official < quotaStart) {
    return {
      class: BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO,
      quota_eligible: false,
      reason: "before_quota_counting_started",
      snapshot_origin: origin,
      official_order_at: official.toISOString(),
    };
  }

  const window = resolveCurrentBabyCycleWindow(input.metadata);
  if (!window.cycle_started_at || !window.cycle_ends_at_exclusive) {
    return {
      class: BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW,
      quota_eligible: false,
      reason: "cycle_window_unresolved",
      snapshot_origin: origin,
      official_order_at: official.toISOString(),
      manual_review_required: true,
    };
  }

  const eligibleStart =
    official && quotaStart && window.cycle_started_at
      ? new Date(Math.max(quotaStart.getTime(), window.cycle_started_at.getTime()))
      : quotaStart;

  if (eligibleStart && official < eligibleStart) {
    return {
      class: BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO,
      quota_eligible: false,
      reason: "before_current_cycle_eligible_window",
      snapshot_origin: origin,
      official_order_at: official.toISOString(),
    };
  }

  if (!isOfficialOrderInCycleWindow(official, window)) {
    if (origin === BILLING_SNAPSHOT_ORIGIN.UNKNOWN) {
      return {
        class: BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW,
        quota_eligible: false,
        reason: "unknown_origin_outside_or_ambiguous_cycle",
        snapshot_origin: origin,
        official_order_at: official.toISOString(),
        manual_review_required: true,
      };
    }
    return {
      class: BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW,
      quota_eligible: false,
      reason: "outside_current_cycle_window",
      snapshot_origin: origin,
      official_order_at: official.toISOString(),
      manual_review_required: true,
    };
  }

  return {
    class: BILLING_SALE_PERIOD_CLASS.FRANQUIA_ELEGIVEL,
    quota_eligible: true,
    reason: "current_cycle_eligible",
    snapshot_origin: origin,
    official_order_at: official.toISOString(),
    cycle_key: window.cycle_key,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 * @param {Date} [now]
 */
export function shouldBypassAtomicQuotaReservation(metadata, now = new Date()) {
  const { active, temporal } = resolveTrialTemporalFromMetadata(metadata, now);
  if (active) {
    return {
      bypass: true,
      admit: true,
      process_sale: true,
      reason: "trial_unlimited",
      trial_state: temporal,
      atomic: false,
      quota_bypassed: true,
    };
  }
  return { bypass: false };
}
