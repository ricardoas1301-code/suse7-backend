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

/**
 * @deprecated S1.HF.6.9A.12A — dunning legado de 3 dias neutralizado.
 * Carência financeira canônica = BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT (10).
 * Mantido como alias de 10 para não reabilitar 3 dias via import antigo.
 */
export const BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT = 10;

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
  PAY_MONTHLY: "PAY_MONTHLY",
  UPDATE_CARD: "UPDATE_CARD",
  WAITING_CARD_CONFIRMATION: "WAITING_CARD_CONFIRMATION",
  GENERATE_INVOICE: "GENERATE_INVOICE",
  NONE: "NONE",
});

/** Estados canônicos da experiência de renovação manual (Minha assinatura). */
export const RENEWAL_EXPERIENCE_STATE = /** @type {const} */ ({
  ACTIVE_NOT_DUE: "ACTIVE_NOT_DUE",
  RENEWAL_AWAITING_GENERATION: "RENEWAL_AWAITING_GENERATION",
  REACTIVATION_AWAITING_GENERATION: "REACTIVATION_AWAITING_GENERATION",
  RENEWAL_PAYMENT_GENERATING: "RENEWAL_PAYMENT_GENERATING",
  RENEWAL_PIX_OPEN: "RENEWAL_PIX_OPEN",
  RENEWAL_BOLETO_OPEN: "RENEWAL_BOLETO_OPEN",
  RENEWAL_PAID: "RENEWAL_PAID",
  PAYMENT_EXPIRED_OR_INVALID: "PAYMENT_EXPIRED_OR_INVALID",
});

/** Estado financeiro civil canônico (DTO — separado de billing_subscriptions.status). */
export const BILLING_FINANCIAL_STATE = /** @type {const} */ ({
  CURRENT: "CURRENT",
  DUE_SOON: "DUE_SOON",
  DUE_TODAY: "DUE_TODAY",
  GRACE_PERIOD: "GRACE_PERIOD",
  SUSPENDED: "SUSPENDED",
});

/** Estado de acesso operacional (DTO). */
export const BILLING_ACCESS_STATE = /** @type {const} */ ({
  LIBERATED: "LIBERATED",
  /** @deprecated use DETAILED_ACCESS_RESTRICTED — alias legado 6.6 */
  LIMITED: "LIMITED",
  DETAILED_ACCESS_RESTRICTED: "DETAILED_ACCESS_RESTRICTED",
  /** @deprecated use access_profile ARCHIVE_READ_ONLY — sync_state HARD_PAUSED não implica tela fechada */
  HARD_PAUSED: "HARD_PAUSED",
  ARCHIVE_READ_ONLY: "ARCHIVE_READ_ONLY",
  BLOCKED: "BLOCKED",
});

/** Perfil canônico de acesso — separado de sync_state (S1.HF.6.8). */
export const BILLING_ACCESS_PROFILE = /** @type {const} */ ({
  FULL_ACCESS: "FULL_ACCESS",
  EXECUTIVE_ONLY: "EXECUTIVE_ONLY",
  ARCHIVE_READ_ONLY: "ARCHIVE_READ_ONLY",
  FINANCIAL_RECOVERY_ONLY: "FINANCIAL_RECOVERY_ONLY",
});

/** Motivo canônico de restrição — separado de access_profile (S1.HF.6.9). */
export const BILLING_ACCESS_RESTRICTION_REASON = /** @type {const} */ ({
  SECURITY_REVOKED: "SECURITY_REVOKED",
  INTEGRATION_REVOKED: "INTEGRATION_REVOKED",
  FINANCIAL_STATE_WITHOUT_FALLBACK: "FINANCIAL_STATE_WITHOUT_FALLBACK",
  TENANT_DISABLED: "TENANT_DISABLED",
  DATA_INTEGRITY_HOLD: "DATA_INTEGRITY_HOLD",
  ADMINISTRATIVE_HOLD: "ADMINISTRATIVE_HOLD",
  /** Pós-trial — owner TRIAL_LIFECYCLE_ENGINE (S1.HF.6.9A.11). */
  TRIAL_EXPIRED: "TRIAL_EXPIRED",
  /** Inadimplência / suspensão financeira — owner PAYMENT_DELINQUENCY_ENGINE (S1.HF.6.9A.12). */
  PAYMENT_DELINQUENCY: "PAYMENT_DELINQUENCY",
});

/** Owner do ciclo financeiro pago (S1.HF.6.9A.12). */
export const BILLING_PAYMENT_DELINQUENCY_OWNER = /** @type {const} */ ({
  PAYMENT_DELINQUENCY_ENGINE: "PAYMENT_DELINQUENCY_ENGINE",
});

/** Estados canônicos do ciclo financeiro pago (S1.HF.6.9A.12). */
export const BILLING_PAID_LIFECYCLE_STATE = /** @type {const} */ ({
  PAID_ACTIVE: "PAID_ACTIVE",
  RENEWAL_AVAILABLE: "RENEWAL_AVAILABLE",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  RENEWAL_PAID_SCHEDULED: "RENEWAL_PAID_SCHEDULED",
  PAYMENT_DUE: "PAYMENT_DUE",
  FINANCIAL_GRACE: "FINANCIAL_GRACE",
  PAID_SUSPENDED: "PAID_SUSPENDED",
  BABY_FALLBACK_ACTIVE: "BABY_FALLBACK_ACTIVE",
  REACTIVATION_PENDING: "REACTIVATION_PENDING",
  PAID_REACTIVATED: "PAID_REACTIVATED",
});

/** Estado de sincronização operacional (DTO). */
export const BILLING_SYNC_STATE = /** @type {const} */ ({
  FULL: "FULL",
  HARD_PAUSED: "HARD_PAUSED",
});

/** Estado financeiro quando trial ativo (sem cobrança). */
export const BILLING_FINANCIAL_STATE_NOT_APPLICABLE = "NOT_APPLICABLE";

/** Ciclo de vida comercial da assinatura (DTO). */
export const BILLING_SUBSCRIPTION_LIFECYCLE_STATUS = /** @type {const} */ ({
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  CANCELED: "CANCELED",
  SUPERSEDED: "SUPERSEDED",
});

/** Contexto do modal de pagamento (renovação vs reativação). */
export const BILLING_PAYMENT_CONTEXT = /** @type {const} */ ({
  MONTHLY_RENEWAL_GRACE: "MONTHLY_RENEWAL_GRACE",
  SUBSCRIPTION_REACTIVATION: "SUBSCRIPTION_REACTIVATION",
});

/** Entitlement efetivo exposto ao seller (contrato × fallback). */
export const BILLING_EFFECTIVE_ENTITLEMENT = /** @type {const} */ ({
  PAID_PLAN: "PAID_PLAN",
  BABY_INTERNAL_FREE: "BABY_INTERNAL_FREE",
  TRIAL_FULL_ACCESS: "TRIAL_FULL_ACCESS",
  /** Pós-trial restrito — NÃO é Baby (S1.HF.6.9A.11). */
  TRIAL_EXPIRED_RESTRICTED: "TRIAL_EXPIRED_RESTRICTED",
});

/** Origem do entitlement efetivo. */
export const BILLING_ENTITLEMENT_SOURCE = /** @type {const} */ ({
  SUBSCRIPTION_ACTIVE: "SUBSCRIPTION_ACTIVE",
  SUSPENSION_FALLBACK: "SUSPENSION_FALLBACK",
  /** @deprecated 6.9A.11 — não usar fallback silencioso trial→Baby */
  TRIAL_EXPIRATION_FALLBACK: "TRIAL_EXPIRATION_FALLBACK",
  TRIAL_LIFECYCLE_EXPIRATION: "TRIAL_LIFECYCLE_EXPIRATION",
  /** Alias canônico 6.9A.12 — Baby pós-suspensão financeira. */
  BABY_FALLBACK: "BABY_FALLBACK",
  NEW_SELLER_TRIAL: "NEW_SELLER_TRIAL",
  INTERNAL_FREE: "INTERNAL_FREE",
});

/** Estado temporal do trial (DTO). */
export const BILLING_TRIAL_STATE = /** @type {const} */ ({
  NOT_STARTED: "NOT_STARTED",
  ELIGIBLE: "ELIGIBLE",
  ACTIVE: "ACTIVE",
  ENDING_SOON: "ENDING_SOON",
  ENDS_TODAY: "ENDS_TODAY",
  CONVERTED: "CONVERTED",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
});

/** Estados canônicos do ciclo de vida do trial (S1.HF.6.9A.11). */
export const BILLING_TRIAL_LIFECYCLE_STATE = /** @type {const} */ ({
  TRIAL_ACTIVE: "TRIAL_ACTIVE",
  TRIAL_ENDING_D3: "TRIAL_ENDING_D3",
  TRIAL_ENDING_D2: "TRIAL_ENDING_D2",
  TRIAL_ENDING_D1: "TRIAL_ENDING_D1",
  TRIAL_EXPIRED_RESTRICTED: "TRIAL_EXPIRED_RESTRICTED",
  PAID_ACTIVE: "PAID_ACTIVE",
});

/** Evento canônico de ativação do trial. */
export const BILLING_TRIAL_ACTIVATION_EVENT = /** @type {const} */ ({
  FIRST_MARKETPLACE_SYNC_READY: "FIRST_MARKETPLACE_SYNC_READY",
});

/** Dias civis padrão do trial (configurável — não hard-code comercial no frontend). */
export const BILLING_TRIAL_DURATION_DAYS_DEFAULT = 15;

/** Limite de proteção do trial — recomendação técnica inicial para homologação. */
export const BILLING_TRIAL_USAGE_LIMIT_RECOMMENDED_DEFAULT = 500;

/** Uso do trial atingiu limite de proteção (sem grace de plano pago). */
export const BILLING_TRIAL_USAGE_STATE = /** @type {const} */ ({
  TRIAL_LIMIT_REACHED: "TRIAL_LIMIT_REACHED",
});

/** Máquina de estados de consumo (independente do billing_financial_state). */
export const BILLING_USAGE_STATE = /** @type {const} */ ({
  WITHIN_LIMIT: "WITHIN_LIMIT",
  LIMIT_REACHED: "LIMIT_REACHED",
  LIMIT_REACHED_GRACE: "LIMIT_REACHED_GRACE",
  LIMIT_RESTRICTED: "LIMIT_RESTRICTED",
  HARD_LIMIT_REACHED: "HARD_LIMIT_REACHED",
});

/** Códigos de domínio — gate backend. */
export const BILLING_ENTITLEMENT_ERROR_CODE = /** @type {const} */ ({
  PLAN_USAGE_LIMIT_RESTRICTED: "PLAN_USAGE_LIMIT_RESTRICTED",
  PLAN_USAGE_LIMIT_DETAILED_ACCESS_RESTRICTED: "PLAN_USAGE_LIMIT_DETAILED_ACCESS_RESTRICTED",
  BABY_LIMIT_ARCHIVE_READ_ONLY: "BABY_LIMIT_ARCHIVE_READ_ONLY",
  BABY_HARD_LIMIT_REACHED: "BABY_HARD_LIMIT_REACHED",
  SYNC_HARD_PAUSED: "SYNC_HARD_PAUSED",
  TRIAL_LIMIT_REACHED: "TRIAL_LIMIT_REACHED",
  FINANCIAL_ACCESS_BLOCKED: "FINANCIAL_ACCESS_BLOCKED",
  BILLING_CAPABILITY_CLASSIFICATION_REQUIRED: "BILLING_CAPABILITY_CLASSIFICATION_REQUIRED",
});

/** Capabilities declarativas — SSOT S1.HF.6.8. */
export const BILLING_ENTITLEMENT_CAPABILITY = /** @type {const} */ ({
  VIEW_EXECUTIVE_CARDS: "VIEW_EXECUTIVE_CARDS",
  VIEW_STORED_LISTS: "VIEW_STORED_LISTS",
  USE_LIST_FILTERS: "USE_LIST_FILTERS",
  VIEW_STORED_DETAILS: "VIEW_STORED_DETAILS",
  VIEW_LIVE_DETAILS: "VIEW_LIVE_DETAILS",
  RUN_REPORTS: "RUN_REPORTS",
  EXPORT_DATA: "EXPORT_DATA",
  EXECUTE_BATCH_ACTIONS: "EXECUTE_BATCH_ACTIONS",
  CHANGE_MARKETPLACE_DATA: "CHANGE_MARKETPLACE_DATA",
  RUN_AUTOMATIONS: "RUN_AUTOMATIONS",
  REQUEST_MANUAL_SYNC: "REQUEST_MANUAL_SYNC",
  RECEIVE_AND_PROCESS_WEBHOOKS: "RECEIVE_AND_PROCESS_WEBHOOKS",
  CALL_MARKETPLACE_APIS: "CALL_MARKETPLACE_APIS",
  MANAGE_BILLING: "MANAGE_BILLING",
  CHANGE_PLAN: "CHANGE_PLAN",
});

/** Aliases legados 6.7 → capability canônica 6.8. */
export const BILLING_ENTITLEMENT_CAPABILITY_LEGACY_ALIAS = /** @type {const} */ ({
  executive_cards: BILLING_ENTITLEMENT_CAPABILITY.VIEW_EXECUTIVE_CARDS,
  detailed_lists: BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_LISTS,
  filters_search: BILLING_ENTITLEMENT_CAPABILITY.USE_LIST_FILTERS,
  sale_rayx: BILLING_ENTITLEMENT_CAPABILITY.VIEW_LIVE_DETAILS,
  listing_rayx: BILLING_ENTITLEMENT_CAPABILITY.VIEW_LIVE_DETAILS,
  detail_modals: BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_DETAILS,
  reports: BILLING_ENTITLEMENT_CAPABILITY.RUN_REPORTS,
  exports: BILLING_ENTITLEMENT_CAPABILITY.EXPORT_DATA,
  batch_actions: BILLING_ENTITLEMENT_CAPABILITY.EXECUTE_BATCH_ACTIONS,
  automations: BILLING_ENTITLEMENT_CAPABILITY.RUN_AUTOMATIONS,
  marketplace_ops: BILLING_ENTITLEMENT_CAPABILITY.CHANGE_MARKETPLACE_DATA,
  active_sync: BILLING_ENTITLEMENT_CAPABILITY.REQUEST_MANUAL_SYNC,
  webhook_ingest: BILLING_ENTITLEMENT_CAPABILITY.RECEIVE_AND_PROCESS_WEBHOOKS,
  executive_refresh: BILLING_ENTITLEMENT_CAPABILITY.VIEW_EXECUTIVE_CARDS,
});

/** Tolerância civil ao atingir limite de vendas (dias). */
export const BILLING_USAGE_LIMIT_GRACE_DAYS_DEFAULT = 5;

/** Limite de vendas do fallback Baby interno pós-suspensão. */
export const BILLING_SUSPENSION_FALLBACK_SALES_LIMIT_DEFAULT = 60;

/** Chave plano fallback interno. */
export const BILLING_SUSPENSION_FALLBACK_PLAN_KEY = "baby_internal_free";

/** Metadata — fallback Baby por suspensão financeira. */
export const BILLING_SUSPENSION_FALLBACK_METADATA_KEYS = /** @type {const} */ ({
  ACTIVE: "suspension_fallback_active",
  SOURCE: "effective_entitlement_source",
  ENTITLEMENT: "effective_entitlement",
  PLAN_KEY: "effective_plan_key",
  PERIOD_START: "fallback_period_start",
  PERIOD_END: "fallback_period_end",
  NEXT_RESET: "fallback_next_reset",
  ACTIVATED_AT: "fallback_activated_at",
  CONTRACTED_PLAN_KEY: "contracted_plan_key",
});

/** Metadata — tolerância de limite de consumo por ciclo. */
export const BILLING_USAGE_LIMIT_METADATA_KEYS = /** @type {const} */ ({
  USAGE_STATE: "usage_state",
  LIMIT_REACHED_AT: "limit_reached_at",
  USAGE_GRACE_END: "usage_grace_end",
  GRACE_CONSUMED_IN_CYCLE: "usage_grace_consumed_in_cycle",
  CYCLE_KEY: "usage_limit_cycle_key",
  BILLED_COUNT: "usage_billed_count",
  /** Limite congelado no início do ciclo — SSOT RPC admissão (S1.HF.6.9A.4). */
  SALES_LIMIT_SNAPSHOT: "sales_limit_snapshot",
  SALES_LIMIT_SNAPSHOT_CYCLE_KEY: "sales_limit_snapshot_cycle_key",
});

/** Metadata — sync pause / gap (Baby HARD_PAUSED). */
export const BILLING_SYNC_METADATA_KEYS = /** @type {const} */ ({
  SYNC_STATE: "sync_state",
  PAUSE_STARTED_AT: "pause_started_at",
  SYNC_RESUMED_AT: "sync_resumed_at",
  DATA_GAP_START: "data_gap_start",
  DATA_GAP_END: "data_gap_end",
  IGNORED_EVENT_COUNT: "ignored_event_count",
  BACKFILL_STATUS: "backfill_status",
  LAST_DATA_UPDATED_AT: "last_data_updated_at",
  FIRST_IGNORED_EVENT_AT: "first_ignored_event_at",
  LAST_IGNORED_EVENT_AT: "last_ignored_event_at",
  IGNORED_MARKETPLACE: "ignored_marketplace",
  IGNORED_ACCOUNT_ID: "ignored_account_id",
  IGNORED_REASON: "ignored_reason",
});

export const BILLING_BACKFILL_STATUS = /** @type {const} */ ({
  NOT_REQUESTED: "NOT_REQUESTED",
});

/** Metadata — trial seller (overlay entitlement, sem assinatura paga). */
export const BILLING_TRIAL_METADATA_KEYS = /** @type {const} */ ({
  TRIAL_STATE: "trial_state",
  TRIAL_STARTED_AT: "trial_started_at",
  TRIAL_START_DATE: "trial_start_date",
  TRIAL_END_DATE: "trial_end_date",
  /** Fim temporal canônico (timestamptz ISO) — 15 dias civis. */
  TRIAL_ENDS_AT: "trial_ends_at",
  TRIAL_ACTIVATION_SOURCE: "trial_activation_source",
  /** @deprecated 6.9A.8 — trial sem limite de vendas; só telemetria legada. */
  TRIAL_USAGE_LIMIT: "trial_usage_limit",
  /** @deprecated 6.9A.8 — volume observado deriva de sales_orders no intervalo. */
  TRIAL_USAGE_COUNT: "trial_usage_count",
  TRIAL_CONVERTED_AT: "trial_converted_at",
  TRIAL_SELECTED_PLAN_ID: "trial_selected_plan_id",
  TRIAL_ELIGIBILITY_EXPIRES_AT: "trial_eligibility_expires_at",
  TRIAL_ORIGINAL_END_DATE: "trial_original_end_date",
  TRIAL_EXTENDED_END_DATE: "trial_extended_end_date",
  TRIAL_EXTENSION_DAYS: "trial_extension_days",
  TRIAL_EXTENSION_REASON: "trial_extension_reason",
  TRIAL_EXTENDED_BY: "trial_extended_by",
  TRIAL_EXTENDED_AT: "trial_extended_at",
  TRIAL_FINGERPRINT: "trial_fingerprint",
  /** Trial único na vida da titularidade. */
  TRIAL_CONSUMED: "trial_consumed",
  /** Instante FIRST_MARKETPLACE_SYNC_READY. */
  OPERATIONAL_CUTOVER_AT: "operational_cutover_at",
  /**
   * Início efetivo da franquia (Baby ou plano pago).
   * NULL enquanto trial_state temporalmente ACTIVE.
   */
  QUOTA_COUNTING_STARTED_AT: "quota_counting_started_at",
});

/** Períodos canônicos de classificação de venda (S1.HF.6.9A.8). */
export const BILLING_SALE_PERIOD_CLASS = /** @type {const} */ ({
  IMPORTACAO_HISTORICA: "IMPORTACAO_HISTORICA",
  PRE_OPERATIONAL_CUTOVER: "PRE_OPERATIONAL_CUTOVER",
  TRIAL_OBSERVADO: "TRIAL_OBSERVADO",
  FRANQUIA_ELEGIVEL: "FRANQUIA_ELEGIVEL",
  MANUAL_REVIEW: "MANUAL_REVIEW",
});

/** Origem canônica da venda (S1.HF.6.9A.10) — nunca assumir post_suse7_sale. */
export const BILLING_SNAPSHOT_ORIGIN = /** @type {const} */ ({
  ONBOARDING_IMPORT: "onboarding_import",
  OPERATIONAL_WEBHOOK: "operational_webhook",
  OPERATIONAL_RECONCILIATION: "operational_reconciliation",
  OPERATIONAL_SYNC: "operational_sync",
  UNKNOWN: "unknown",
});

/** Propriedade canônica da pausa Baby (S1.HF.6.9A.10). */
export const BILLING_HARD_PAUSE_OWNER = /** @type {const} */ ({
  BABY_QUOTA_ENGINE: "BABY_QUOTA_ENGINE",
});

/** Owners de domínio — não misturar (S1.HF.6.9A.12). */
export const BILLING_DOMAIN_ENGINE_OWNER = /** @type {const} */ ({
  PAYMENT_DELINQUENCY_ENGINE: "PAYMENT_DELINQUENCY_ENGINE",
  TRIAL_LIFECYCLE_ENGINE: "TRIAL_LIFECYCLE_ENGINE",
  BABY_QUOTA_ENGINE: "BABY_QUOTA_ENGINE",
  CONSUMPTION_LIMIT_ENGINE: "CONSUMPTION_LIMIT_ENGINE",
});

/** Fonte da materialização da pausa Baby. */
export const BILLING_HARD_PAUSE_SOURCE = /** @type {const} */ ({
  RUNTIME: "RUNTIME",
  MIGRATION_BASELINE: "MIGRATION_BASELINE",
});

/** Provider interno — registro overlay de entitlement (não é assinatura paga). */
export const BILLING_ENTITLEMENT_OVERLAY_PROVIDER = "suse7_entitlement";
export const BILLING_ENTITLEMENT_OVERLAY_STATUS = "entitlement_only";

/** Prefixos liberados em LIMIT_RESTRICTED ou suspensão operacional. */
export const BILLING_LIMIT_RESTRICTED_ALLOWED_PATH_PREFIXES = [
  "/perfil/assinatura",
  "/assinatura",
  "/billing",
  "/suporte",
  "/support",
];

/** Prefixos bloqueados em LIMIT_RESTRICTED. */
export const BILLING_LIMIT_RESTRICTED_BLOCKED_PATH_PREFIXES = [
  "/vendas",
  "/precific",
  "/anuncios",
  "/anúncios",
  "/produtos",
  "/concorrencia",
  "/concorrência",
  "/relatorios",
  "/relatórios",
  "/registros",
  "/dashboard",
  "/raiox",
  "/rayx",
];

/** Ações canônicas da experiência de renovação manual. */
export const RENEWAL_EXPERIENCE_ACTION = /** @type {const} */ ({
  RENEW_SUBSCRIPTION: "RENEW_SUBSCRIPTION",
  VIEW_PIX: "VIEW_PIX",
  REISSUE_BOLETO: "REISSUE_BOLETO",
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
