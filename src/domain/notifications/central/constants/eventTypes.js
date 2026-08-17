// =============================================================================
// Tipos de evento por categoria (catálogo em código — espelha DB seed)
// =============================================================================

import { S7_NOTIFICATION_CATEGORY } from "./categories.js";

/** @type {Readonly<Record<string, { typeKey: string, mandatory?: boolean, templateKey?: string, severity?: string }>>} */
export const S7_NOTIFICATION_TYPE_CATALOG = Object.freeze({
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:PAYMENT_CONFIRMED`]: {
    typeKey: "PAYMENT_CONFIRMED",
    templateKey: "billing.payment.confirmed",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:PAYMENT_FAILED`]: {
    typeKey: "PAYMENT_FAILED",
    mandatory: true,
    templateKey: "billing.payment.failed",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:PAYMENT_GENERATED`]: {
    typeKey: "PAYMENT_GENERATED",
    templateKey: "billing.payment.generated",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:SUSPENDED`]: {
    typeKey: "SUSPENDED",
    mandatory: true,
    templateKey: "billing.subscription.suspended",
    severity: "critical",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:REACTIVATED`]: {
    typeKey: "REACTIVATED",
    templateKey: "billing.subscription.reactivated",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:ENTERED_GRACE`]: {
    typeKey: "ENTERED_GRACE",
    mandatory: true,
    templateKey: "billing.grace.started",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:GRACE_LAST_DAY`]: {
    typeKey: "GRACE_LAST_DAY",
    templateKey: "billing.grace.last_day",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:RENEWAL_AVAILABLE`]: {
    typeKey: "RENEWAL_AVAILABLE",
    templateKey: "billing.renewal.available",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:PAYMENT_PENDING`]: {
    typeKey: "PAYMENT_PENDING",
    templateKey: "billing.payment.pending",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:PAYMENT_DUE`]: {
    typeKey: "PAYMENT_DUE",
    templateKey: "billing.payment.due",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:BABY_FALLBACK_ACTIVATED`]: {
    typeKey: "BABY_FALLBACK_ACTIVATED",
    templateKey: "billing.baby.fallback_activated",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:RENEWAL_COMPLETED`]: {
    typeKey: "RENEWAL_COMPLETED",
    templateKey: "billing.renewal.completed",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:TRIAL_ENDING_D3`]: {
    typeKey: "TRIAL_ENDING_D3",
    templateKey: "billing.trial.ending_d3",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:TRIAL_ENDING_D2`]: {
    typeKey: "TRIAL_ENDING_D2",
    templateKey: "billing.trial.ending_d2",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:TRIAL_ENDING_D1`]: {
    typeKey: "TRIAL_ENDING_D1",
    templateKey: "billing.trial.ending_d1",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.BILLING}:TRIAL_EXPIRED`]: {
    typeKey: "TRIAL_EXPIRED",
    templateKey: "billing.trial.expired",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.ACCOUNT_HEALTH}:MARKETPLACE_DISCONNECTED`]: {
    typeKey: "MARKETPLACE_DISCONNECTED",
    mandatory: true,
    templateKey: "account.marketplace.disconnected",
    severity: "critical",
  },
  [`${S7_NOTIFICATION_CATEGORY.PROFIT}:NEGATIVE_MARGIN`]: {
    typeKey: "NEGATIVE_MARGIN",
    templateKey: "profit.negative.margin",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.MARKETPLACE}:FEE_CHANGED`]: {
    typeKey: "FEE_CHANGED",
    templateKey: "marketplace.fee.changed",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.MARKETPLACE}:PRICE_CHANGED`]: {
    typeKey: "PRICE_CHANGED",
    templateKey: "marketplace.price.changed",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.SYNC}:SYNC_FAILED`]: {
    typeKey: "SYNC_FAILED",
    templateKey: "sync.failed",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.SYSTEM}:SYSTEM_ALERT`]: {
    typeKey: "SYSTEM_ALERT",
    templateKey: "system.alert",
    severity: "info",
  },
  [`${S7_NOTIFICATION_CATEGORY.SYSTEM}:FALE_CONOSCO_TEAM`]: {
    typeKey: "FALE_CONOSCO_TEAM",
    templateKey: "system.fale_conosco.team",
    severity: "info",
    mandatory: true,
    supportedChannels: ["email"],
  },
  [`${S7_NOTIFICATION_CATEGORY.SYSTEM}:FALE_CONOSCO_CONFIRMATION`]: {
    typeKey: "FALE_CONOSCO_CONFIRMATION",
    templateKey: "system.fale_conosco.confirmation",
    severity: "info",
    mandatory: true,
    supportedChannels: ["email"],
  },
  [`${S7_NOTIFICATION_CATEGORY.SALES}:ORDER_CANCELLED`]: {
    typeKey: "ORDER_CANCELLED",
    templateKey: "sales.order.cancelled",
    severity: "warning",
  },
  [`${S7_NOTIFICATION_CATEGORY.SALES}:MANUAL_SALE_RAYX`]: {
    typeKey: "MANUAL_SALE_RAYX",
    templateKey: "sales.manual.rayx",
    severity: "info",
    supportedChannels: ["whatsapp", "email"],
  },
  [`${S7_NOTIFICATION_CATEGORY.SALES}:MANUAL_SALES_REPORT`]: {
    typeKey: "MANUAL_SALES_REPORT",
    templateKey: "sales.manual.report",
    severity: "info",
    supportedChannels: ["whatsapp", "email"],
  },
  [`${S7_NOTIFICATION_CATEGORY.COMPETITION}:MANUAL_COMPETITION_REPORT`]: {
    typeKey: "MANUAL_COMPETITION_REPORT",
    templateKey: "competition.manual.report",
    severity: "info",
    supportedChannels: ["whatsapp", "email"],
  },
  [`${S7_NOTIFICATION_CATEGORY.SALES}:DAILY_SALES_SUMMARY`]: {
    typeKey: "DAILY_SALES_SUMMARY",
    templateKey: "sales.daily.summary",
    severity: "info",
    supportedChannels: ["in_app", "email", "whatsapp", "push"],
  },
  [`${S7_NOTIFICATION_CATEGORY.INVENTORY}:LOW_STOCK`]: {
    typeKey: "LOW_STOCK",
    templateKey: "inventory.low.stock",
    severity: "warning",
  },
});

/**
 * @param {string} category
 * @param {string} type
 */
export function lookupNotificationTypeCatalog(category, type) {
  const key = `${String(category).trim()}:${String(type).trim()}`;
  return S7_NOTIFICATION_TYPE_CATALOG[key] ?? null;
}

/**
 * @param {string} category
 * @param {string} type
 */
export function isValidCentralNotificationType(category, type) {
  return lookupNotificationTypeCatalog(category, type) != null;
}
