// ======================================================================
// Limite duro Baby — sem tolerância de cinco dias (S1.HF.6.7)
// ======================================================================

import { BILLING_USAGE_STATE } from "../billingConstants.js";

/**
 * @param {{
 *   usageCount: number;
 *   usageLimit: number | null;
 *   persistedUsageState?: string | null;
 *   syncState?: string | null;
 * }} input
 */
export function resolveBabyHardLimitState(input) {
  const usageLimit = input.usageLimit != null ? Number(input.usageLimit) : null;
  const usageCount = Math.max(0, Number(input.usageCount ?? 0));
  const syncPaused = input.syncState === "HARD_PAUSED";

  if (usageLimit == null || !Number.isFinite(usageLimit)) {
    return {
      usage_state: BILLING_USAGE_STATE.WITHIN_LIMIT,
      usage_count: usageCount,
      usage_limit: null,
      should_hard_pause: false,
      already_hard_paused: syncPaused,
    };
  }

  if (syncPaused || input.persistedUsageState === BILLING_USAGE_STATE.HARD_LIMIT_REACHED) {
    return {
      usage_state: BILLING_USAGE_STATE.HARD_LIMIT_REACHED,
      usage_count: usageCount,
      usage_limit: usageLimit,
      should_hard_pause: false,
      already_hard_paused: true,
    };
  }

  if (usageCount >= usageLimit) {
    return {
      usage_state: BILLING_USAGE_STATE.HARD_LIMIT_REACHED,
      usage_count: usageCount,
      usage_limit: usageLimit,
      should_hard_pause: true,
      already_hard_paused: false,
    };
  }

  return {
    usage_state: BILLING_USAGE_STATE.WITHIN_LIMIT,
    usage_count: usageCount,
    usage_limit: usageLimit,
    should_hard_pause: false,
    already_hard_paused: false,
  };
}

/**
 * Baby não usa grace de plano pago.
 */
export function resolveBabyUsageStateForDisplay(input) {
  return resolveBabyHardLimitState(input);
}
