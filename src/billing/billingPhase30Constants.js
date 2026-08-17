// ======================================================================
// Fase 3.0 — Revenue Experience (contratos estáveis)
// ======================================================================

/** Timeline — append-only */
export const BILLING_TIMELINE_EVENT = /** @type {const} */ ({
  SUBSCRIPTION_CREATED: "SUBSCRIPTION_CREATED",
  PAYMENT_GENERATED: "PAYMENT_GENERATED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  RENEWAL_STARTED: "RENEWAL_STARTED",
  RENEWAL_COMPLETED: "RENEWAL_COMPLETED",
  ENTERED_GRACE: "ENTERED_GRACE",
  SUSPENDED: "SUSPENDED",
  REACTIVATED: "REACTIVATED",
  PLAN_CHANGED: "PLAN_CHANGED",
  LIMIT_REACHED: "LIMIT_REACHED",
});

export const BILLING_TIMELINE_SEVERITY = /** @type {const} */ ({
  INFO: "info",
  WARNING: "warning",
  DANGER: "danger",
  CRITICAL: "critical",
});

export const BILLING_TIMELINE_SOURCE = /** @type {const} */ ({
  SYSTEM: "system",
  ENGINE: "engine",
  WEBHOOK: "webhook",
  CHECKOUT: "checkout",
  JOB: "job",
  SELLER: "seller",
  ADMIN: "admin",
});

/** Audit */
export const BILLING_AUDIT_ACTOR = /** @type {const} */ ({
  SELLER: "seller",
  SYSTEM: "system",
  JOB: "job",
  WEBHOOK: "webhook",
  ADMIN: "admin",
  PROVIDER: "provider",
});

export const BILLING_AUDIT_ACTION = /** @type {const} */ ({
  SUBSCRIPTION_STATUS_CHANGED: "subscription_status_changed",
  RENEWAL_CYCLE_STATUS_CHANGED: "renewal_cycle_status_changed",
  PAYMENT_CREATED: "payment_created",
  PAYMENT_STATUS_CHANGED: "payment_status_changed",
  PLAN_CHANGE_REQUESTED: "plan_change_requested",
  PLAN_CHANGE_APPLIED: "plan_change_applied",
  CHECKOUT_STARTED: "checkout_started",
  GRACE_STARTED: "grace_started",
  SUSPENSION_APPLIED: "suspension_applied",
});

/** Revenue health */
export const REVENUE_HEALTH_LEVEL = /** @type {const} */ ({
  HEALTHY: "HEALTHY",
  WARNING: "WARNING",
  RISK: "RISK",
  CRITICAL: "CRITICAL",
});

/** Analytics metric keys (platform) */
export const BILLING_ANALYTICS_METRIC = /** @type {const} */ ({
  MRR_CENTS: "mrr_cents",
  ARR_CENTS: "arr_cents",
  ACTIVE_SUBSCRIPTIONS: "active_subscriptions",
  GRACE_SUBSCRIPTIONS: "grace_subscriptions",
  SUSPENDED_SUBSCRIPTIONS: "suspended_subscriptions",
  CHURN_COUNT: "churn_count",
  FAILED_PAYMENTS: "failed_payments",
  REVENUE_RECOVERED_CENTS: "revenue_recovered_cents",
  REVENUE_AT_RISK_CENTS: "revenue_at_risk_cents",
});

/** Notification channels */
export const BILLING_NOTIFICATION_CHANNEL = /** @type {const} */ ({
  IN_APP: "in_app",
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  PUSH: "push",
});

export const BILLING_NOTIFICATION_DISPATCH_STATUS = /** @type {const} */ ({
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/** Mapeamento renewal hook → template_key */
export const RENEWAL_EVENT_TO_TEMPLATE_KEY = /** @type {Record<string, string>} */ ({
  renewal_3_days_before: "renewal.reminder_3_days",
  renewal_2_days_before: "renewal.reminder_2_days",
  renewal_1_day_before: "renewal.reminder_1_day",
  renewal_due_today: "renewal.due_today",
  payment_failed: "payment.failed",
  grace_period_started: "grace.started",
  grace_period_escalated: "grace.started",
  subscription_suspended: "subscription.suspended",
  renewal_paid: "payment.confirmed",
});

export const BILLING_PHASE30_LOG = /** @type {const} */ ({
  TIMELINE_RECORDED: "S7_BILLING_TIMELINE_RECORDED",
  AUDIT_RECORDED: "S7_BILLING_AUDIT_RECORDED",
  NOTIFICATION_DISPATCHED: "S7_BILLING_NOTIFICATION_DISPATCHED",
  REVENUE_HEALTH_COMPUTED: "S7_BILLING_REVENUE_HEALTH_COMPUTED",
  ANALYTICS_COMPUTED: "S7_BILLING_ANALYTICS_COMPUTED",
});
