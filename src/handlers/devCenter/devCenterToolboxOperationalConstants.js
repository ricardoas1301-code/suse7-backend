// =============================================================================
// Dev Center Toolbox — constantes operacionais (S1 Bloco 2)
// =============================================================================

/** @typedef {"success" | "error" | "blocked"} DevCenterToolboxOperationStatus */

export const DEV_CENTER_TOOLBOX_SUBSCRIPTION_ACTION_IDS = Object.freeze([
  "enable_trial",
  "end_trial",
  "add_subscription_days",
  "add_subscription_sales",
  "reset_consumption",
  "recalculate_consumption",
]);

export const DEV_CENTER_TOOLBOX_DEFAULTS = Object.freeze({
  TRIAL_DAYS: 15,
  ADDED_DAYS: 15,
  ADDED_SALES: 100,
  REASON_MIN_LENGTH: 8,
});

export const DEV_CENTER_TOOLBOX_METADATA_KEYS = Object.freeze({
  TRIAL_ENDS_AT: "trial_ends_at",
  TRIAL_STARTED_AT: "trial_started_at",
  TRIAL_ENDED_AT: "trial_ended_at",
  EXTRA_DAYS_TOTAL: "admin_extra_days_total",
  EXTRA_SALES_BONUS: "admin_extra_sales_bonus",
  USAGE_RESET_AT: "admin_usage_reset_at",
  USAGE_RECALCULATED_AT: "admin_usage_recalculated_at",
});

/**
 * @param {string | null | undefined} actionId
 */
export function isDevCenterToolboxSubscriptionActionId(actionId) {
  return DEV_CENTER_TOOLBOX_SUBSCRIPTION_ACTION_IDS.includes(String(actionId ?? "").trim());
}
