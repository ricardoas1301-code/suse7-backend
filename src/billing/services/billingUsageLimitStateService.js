// ======================================================================
// Máquina de estados de consumo — WITHIN_LIMIT / GRACE / RESTRICTED (S1.HF.6.6)
// ======================================================================

import {
  BILLING_USAGE_LIMIT_GRACE_DAYS_DEFAULT,
  BILLING_USAGE_LIMIT_METADATA_KEYS,
  BILLING_USAGE_STATE,
} from "../billingConstants.js";
import { addBillingCivilDays, diffBillingCivilDays, parseBillingCivilDate } from "./billingCycleService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function resolveUsageLimitGraceDays() {
  const raw = Number(process.env.BILLING_USAGE_LIMIT_GRACE_DAYS ?? BILLING_USAGE_LIMIT_GRACE_DAYS_DEFAULT);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : BILLING_USAGE_LIMIT_GRACE_DAYS_DEFAULT;
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function readUsageLimitStateFromMetadata(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return {
    usage_state: asTrimmedString(meta[BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_STATE]),
    limit_reached_at: parseBillingCivilDate(meta[BILLING_USAGE_LIMIT_METADATA_KEYS.LIMIT_REACHED_AT]),
    usage_grace_end: parseBillingCivilDate(meta[BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_GRACE_END]),
    grace_consumed_in_cycle: Boolean(meta[BILLING_USAGE_LIMIT_METADATA_KEYS.GRACE_CONSUMED_IN_CYCLE]),
    cycle_key: asTrimmedString(meta[BILLING_USAGE_LIMIT_METADATA_KEYS.CYCLE_KEY]),
  };
}

/**
 * Avalia estado de consumo civil (5 dias de tolerância, uma vez por ciclo).
 *
 * @param {{
 *   usageCount: number;
 *   usageLimit: number | null;
 *   civilNow: string;
 *   cycleKey: string;
 *   persisted?: ReturnType<typeof readUsageLimitStateFromMetadata>;
 *   graceDays?: number;
 * }} input
 */
export function resolveUsageLimitStateMachine(input) {
  const civilNow = parseBillingCivilDate(input.civilNow);
  const usageLimit = input.usageLimit != null ? Number(input.usageLimit) : null;
  const usageCount = Math.max(0, Number(input.usageCount ?? 0));
  const graceDays = input.graceDays ?? resolveUsageLimitGraceDays();
  const persisted = input.persisted ?? {};
  const cycleKey = asTrimmedString(input.cycleKey) ?? "";

  if (!civilNow || usageLimit == null || !Number.isFinite(usageLimit) || usageLimit <= 0) {
    return {
      usage_state: BILLING_USAGE_STATE.WITHIN_LIMIT,
      usage_count: usageCount,
      usage_limit: usageLimit,
      limit_reached_at: null,
      usage_grace_end: null,
      grace_consumed_in_cycle: false,
      cycle_key: cycleKey,
      metadata_patch: null,
    };
  }

  if (usageCount < usageLimit) {
    const sameCycle = persisted.cycle_key && persisted.cycle_key === cycleKey;
    if (sameCycle && persisted.usage_state === BILLING_USAGE_STATE.LIMIT_RESTRICTED) {
      return {
        usage_state: BILLING_USAGE_STATE.LIMIT_RESTRICTED,
        usage_count: usageCount,
        usage_limit: usageLimit,
        limit_reached_at: persisted.limit_reached_at,
        usage_grace_end: persisted.usage_grace_end,
        grace_consumed_in_cycle: true,
        cycle_key: cycleKey,
        metadata_patch: null,
      };
    }
    return {
      usage_state: BILLING_USAGE_STATE.WITHIN_LIMIT,
      usage_count: usageCount,
      usage_limit: usageLimit,
      limit_reached_at: null,
      usage_grace_end: null,
      grace_consumed_in_cycle: false,
      cycle_key: cycleKey,
      metadata_patch:
        persisted.cycle_key && persisted.cycle_key !== cycleKey
          ? buildUsageLimitCycleResetPatch(cycleKey)
          : null,
    };
  }

  const cycleChanged = Boolean(persisted.cycle_key && persisted.cycle_key !== cycleKey);
  let limitReachedAt = cycleChanged ? civilNow : persisted.limit_reached_at ?? civilNow;
  let graceEnd = cycleChanged
    ? addBillingCivilDays(limitReachedAt, graceDays)
    : persisted.usage_grace_end ?? addBillingCivilDays(limitReachedAt, graceDays);
  const graceConsumed = cycleChanged ? false : Boolean(persisted.grace_consumed_in_cycle);

  if (!graceEnd || !limitReachedAt) {
    limitReachedAt = civilNow;
    graceEnd = addBillingCivilDays(limitReachedAt, graceDays);
  }

  if (graceConsumed && persisted.cycle_key === cycleKey) {
    return {
      usage_state: BILLING_USAGE_STATE.LIMIT_RESTRICTED,
      usage_count: usageCount,
      usage_limit: usageLimit,
      limit_reached_at: limitReachedAt,
      usage_grace_end: graceEnd,
      grace_consumed_in_cycle: true,
      cycle_key: cycleKey,
      metadata_patch: buildUsageLimitStatePatch({
        usageState: BILLING_USAGE_STATE.LIMIT_RESTRICTED,
        limitReachedAt,
        graceEnd,
        graceConsumed: true,
        cycleKey,
      }),
    };
  }

  const daysAfterLimit = diffBillingCivilDays(limitReachedAt, civilNow);
  const inGraceWindow = daysAfterLimit != null && daysAfterLimit <= graceDays;

  const usageState = inGraceWindow
    ? BILLING_USAGE_STATE.LIMIT_REACHED_GRACE
    : BILLING_USAGE_STATE.LIMIT_RESTRICTED;
  const nextGraceConsumed = usageState === BILLING_USAGE_STATE.LIMIT_RESTRICTED || graceConsumed;

  return {
    usage_state: usageState,
    usage_count: usageCount,
    usage_limit: usageLimit,
    limit_reached_at: limitReachedAt,
    usage_grace_end: graceEnd,
    grace_consumed_in_cycle: nextGraceConsumed,
    cycle_key: cycleKey,
    metadata_patch: buildUsageLimitStatePatch({
      usageState,
      limitReachedAt,
      graceEnd,
      graceConsumed: nextGraceConsumed,
      cycleKey,
    }),
  };
}

/**
 * @param {string} cycleKey
 */
export function buildUsageLimitCycleResetPatch(cycleKey) {
  return {
    [BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_STATE]: BILLING_USAGE_STATE.WITHIN_LIMIT,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.LIMIT_REACHED_AT]: null,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_GRACE_END]: null,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.GRACE_CONSUMED_IN_CYCLE]: false,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.CYCLE_KEY]: cycleKey,
  };
}

/**
 * @param {{
 *   usageState: string;
 *   limitReachedAt: string;
 *   graceEnd: string | null;
 *   graceConsumed: boolean;
 *   cycleKey: string;
 * }} input
 */
export function buildUsageLimitStatePatch(input) {
  return {
    [BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_STATE]: input.usageState,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.LIMIT_REACHED_AT]: input.limitReachedAt,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_GRACE_END]: input.graceEnd,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.GRACE_CONSUMED_IN_CYCLE]: input.graceConsumed,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.CYCLE_KEY]: input.cycleKey,
  };
}
