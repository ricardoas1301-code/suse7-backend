// ======================================================================
// billingConstants.js — contratos estáveis (sem segredos)
// ======================================================================

/** Métodos aceitos no checkout; cartão só quando houver tokenização (BILLING 04). */
export const CHECKOUT_PAYMENT_METHODS = /** @type {const} */ (["BOLETO", "PIX", "CREDIT_CARD"]);

// TODO S7 BILLING: Implementar Pix recorrente/Pix automático em fase futura, separado do fluxo de cartão.

/** Status persistidos em `billing_subscriptions.status`. */
export const SUBSCRIPTION_STATUS = /** @type {const} */ ({
  PENDING: "pending",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  REFUNDED: "refunded",
  INTERNAL_FREE: "internal_free",
});

/** Status que são encerrados ao iniciar novo checkout. */
export const SUBSCRIPTION_STATUS_SUPERSEDED = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PENDING,
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.INTERNAL_FREE,
];

/** Inadimplência persistida em `billing_subscriptions.metadata`. */
export const DELINQUENCY_STATUS = /** @type {const} */ ({
  NONE: "none",
  GRACE: "grace",
  SUSPENDED: "suspended",
});

/** Grace period padrão (dias) para cobrança vencida (dunning legado). */
export const BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT = 3;

/** Grace period padrão (dias) do motor de renovação Fase 2.1. */
export const BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT = 10;

/** Dias antes do vencimento para iniciar pré-renovação (alertas 3/2/1). */
export const BILLING_RENEWAL_PRE_RENEWAL_DAYS_DEFAULT = 3;

/** Status persistidos em billing_subscriptions.status (valores canônicos). */
export const BILLING_SUBSCRIPTION_STATUS = /** @type {const} */ ({
  ACTIVE: "active",
  PENDING: "pending",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  REFUNDED: "refunded",
  INTERNAL_FREE: "internal_free",
});

/** Estados lógicos de renovação (metadata.renewal_subscription_status + ciclos). */
export const RENEWAL_SUBSCRIPTION_STATUS = /** @type {const} */ ({
  ACTIVE: "ACTIVE",
  PENDING_RENEWAL: "PENDING_RENEWAL",
  GRACE_PERIOD: "GRACE_PERIOD",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  SUSPENDED: "SUSPENDED",
  CANCELED: "CANCELED",
});

/** Estratégia do ciclo — billing_renewal_cycles.renewal_strategy */
export const RENEWAL_STRATEGY = /** @type {const} */ ({
  AUTO_CARD: "AUTO_CARD",
  MANUAL_PIX: "MANUAL_PIX",
  MANUAL_BOLETO: "MANUAL_BOLETO",
  MANUAL_CARD: "MANUAL_CARD",
  HYBRID: "HYBRID",
});

/** Status operacional do ciclo — billing_renewal_cycles.renewal_status */
export const RENEWAL_STATUS = /** @type {const} */ ({
  SCHEDULED: "SCHEDULED",
  PRE_RENEWAL: "PRE_RENEWAL",
  PENDING_PAYMENT: "PENDING_PAYMENT",
  AUTO_CHARGE_PROCESSING: "AUTO_CHARGE_PROCESSING",
  PAID: "PAID",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  GRACE_PERIOD: "GRACE_PERIOD",
  SUSPENDED: "SUSPENDED",
  CANCELED: "CANCELED",
  SKIPPED: "SKIPPED",
  SUPERSEDED: "SUPERSEDED",
  EXPIRED: "EXPIRED",
  CLOSED: "CLOSED",
});

/**
 * Regra oficial Fase 2.1: no máximo 1 ciclo OPEN por subscription_id.
 * Alertas WARNING/DANGER/CRITICAL são níveis de UI (RENEWAL_ALERT_LEVEL), não renewal_status.
 */
export const RENEWAL_CYCLE_OPEN_STATUSES = /** @type {readonly string[]} */ ([
  RENEWAL_STATUS.SCHEDULED,
  RENEWAL_STATUS.PRE_RENEWAL,
  RENEWAL_STATUS.PENDING_PAYMENT,
  RENEWAL_STATUS.AUTO_CHARGE_PROCESSING,
  RENEWAL_STATUS.PAYMENT_FAILED,
  RENEWAL_STATUS.GRACE_PERIOD,
  RENEWAL_STATUS.SUSPENDED,
]);

/** Estados terminais — não competem por slot OPEN. */
export const RENEWAL_CYCLE_CLOSED_STATUSES = /** @type {readonly string[]} */ ([
  RENEWAL_STATUS.PAID,
  RENEWAL_STATUS.CANCELED,
  RENEWAL_STATUS.SKIPPED,
  RENEWAL_STATUS.SUPERSEDED,
  RENEWAL_STATUS.EXPIRED,
  RENEWAL_STATUS.CLOSED,
]);

/** Prioridade para escolher ciclo canônico quando há inconsistência (menor = mais avançado). */
export const RENEWAL_CYCLE_OPEN_STATUS_PRIORITY = /** @type {Record<string, number>} */ ({
  [RENEWAL_STATUS.SUSPENDED]: 0,
  [RENEWAL_STATUS.GRACE_PERIOD]: 1,
  [RENEWAL_STATUS.PAYMENT_FAILED]: 2,
  [RENEWAL_STATUS.AUTO_CHARGE_PROCESSING]: 3,
  [RENEWAL_STATUS.PENDING_PAYMENT]: 4,
  [RENEWAL_STATUS.PRE_RENEWAL]: 5,
  [RENEWAL_STATUS.SCHEDULED]: 6,
});

/** Status da tentativa automática no cartão. */
export const RENEWAL_AUTO_CHARGE_STATUS = /** @type {const} */ ({
  PROCESSING: "PROCESSING",
  PAID: "PAID",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

/** Ações do histórico de pagamentos (backend → frontend). */
export const PAYMENT_HISTORY_ACTION_TYPE = /** @type {const} */ ({
  VIEW_PIX_QR: "VIEW_PIX_QR",
  VIEW_BOLETO: "VIEW_BOLETO",
  PAY_RENEWAL: "PAY_RENEWAL",
  UPDATE_CARD: "UPDATE_CARD",
  WAITING_CARD_CONFIRMATION: "WAITING_CARD_CONFIRMATION",
  GENERATE_INVOICE: "GENERATE_INVOICE",
  NONE: "NONE",
});

/** Níveis de alerta de renovação (Fase 2.1 — contrato frontend). */
export const RENEWAL_ALERT_LEVEL = /** @type {const} */ ({
  INFO: "INFO",
  WARNING: "WARNING",
  DANGER: "DANGER",
  CRITICAL: "CRITICAL",
  CRITICAL_FINAL: "CRITICAL_FINAL",
  SUSPENDED: "SUSPENDED",
});

/** Frequência de popup (anti-spam). */
export const RENEWAL_POPUP_FREQUENCY = /** @type {const} */ ({
  ONCE_PER_DAY: "ONCE_PER_DAY",
  EVERY_12_HOURS: "EVERY_12_HOURS",
  EVERY_6_HOURS: "EVERY_6_HOURS",
  ON_LOGIN: "ON_LOGIN",
  ALWAYS_CRITICAL: "ALWAYS_CRITICAL",
});

/** Status de acesso exposto ao frontend (renovação). */
export const RENEWAL_ACCESS_STATUS = /** @type {const} */ ({
  FULL: "FULL",
  GRACE: "GRACE",
  SUSPENDED: "SUSPENDED",
});

/** Eventos internos de notificação (entrega completa em missão futura). */
export const RENEWAL_NOTIFICATION_EVENT = /** @type {const} */ ({
  RENEWAL_3_DAYS_BEFORE: "renewal_3_days_before",
  RENEWAL_2_DAYS_BEFORE: "renewal_2_days_before",
  RENEWAL_1_DAY_BEFORE: "renewal_1_day_before",
  RENEWAL_DUE_TODAY: "renewal_due_today",
  PAYMENT_FAILED: "payment_failed",
  GRACE_PERIOD_STARTED: "grace_period_started",
  GRACE_ESCALATED: "grace_period_escalated",
  SUBSCRIPTION_SUSPENDED: "subscription_suspended",
  RENEWAL_PAID: "renewal_paid",
});

/** Logs estruturados do motor de renovação Fase 2. */
export const RENEWAL_ENGINE_LOG = /** @type {const} */ ({
  START: "S7_RENEWAL_ENGINE_START",
  CANDIDATE: "S7_RENEWAL_ENGINE_CANDIDATE",
  CYCLE_CREATED: "S7_RENEWAL_CYCLE_CREATED",
  PAYMENT_CREATED: "S7_RENEWAL_PAYMENT_CREATED",
  AUTO_CHARGE_ATTEMPTED: "S7_RENEWAL_AUTO_CHARGE_ATTEMPTED",
  AUTO_CHARGE_FAILED: "S7_RENEWAL_AUTO_CHARGE_FAILED",
  AUTO_CHARGE_PAID: "S7_RENEWAL_AUTO_CHARGE_PAID",
  GRACE_STARTED: "S7_RENEWAL_GRACE_STARTED",
  GRACE_ESCALATED: "S7_RENEWAL_GRACE_ESCALATED",
  CRITICAL_FINAL: "S7_RENEWAL_CRITICAL_FINAL",
  SUBSCRIPTION_SUSPENDED: "S7_RENEWAL_SUBSCRIPTION_SUSPENDED",
  NOTICE_COMPUTED: "S7_RENEWAL_NOTICE_COMPUTED",
  NOTICE_STATE_UPDATED: "S7_RENEWAL_NOTICE_STATE_UPDATED",
  CONSISTENCY: "S7_RENEWAL_CYCLE_CONSISTENCY",
  END: "S7_RENEWAL_ENGINE_END",
});

/** Tolerância de crescimento (limite de vendas ultrapassado) — seller_ecosystem. */
export const BILLING_USAGE_GROWTH_GRACE_PERIOD_DAYS_DEFAULT = 30;

/** Campos em metadata da assinatura / seller para grace de uso (futuro motor completo). */
export const USAGE_GROWTH_GRACE_METADATA_KEYS = /** @type {const} */ ({
  USAGE_LIMIT_EXCEEDED_AT: "usage_limit_exceeded_at",
  GRACE_PERIOD_STARTED_AT: "grace_period_started_at",
  GRACE_PERIOD_ENDS_AT: "usage_grace_period_ends_at",
  USAGE_GRACE_STATUS: "usage_grace_status",
  UPGRADE_REQUIRED_AFTER_GRACE: "upgrade_required_after_grace",
});

/** Status de grace de uso (limite mensal). */
export const USAGE_GROWTH_GRACE_STATUS = /** @type {const} */ ({
  NONE: "none",
  ACTIVE: "active",
  EXPIRED: "expired",
});
