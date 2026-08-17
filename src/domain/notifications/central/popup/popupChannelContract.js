// =============================================================================
// S7 — Canal Pop-up Oficial (Fase S5.7)
// Contrato operacional do canal — infraestrutura, sem evento/template de negócio.
// =============================================================================

/** Código canônico (Registro Oficial de Canais S5.3). */
export const S7_POPUP_CHANNEL_CODE = "popup";

/** Tipos de exibição visual (sem regra de negócio). */
export const S7_POPUP_DISPLAY_TYPE = Object.freeze({
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
  CRITICAL: "critical",
});

/** Estratégia de quando exibir. */
export const S7_POPUP_DISPLAY_MODE = Object.freeze({
  IMMEDIATE: "immediate",
  ON_DEMAND: "on_demand",
});

/** Ciclo de vida da entrega pop-up. */
export const S7_POPUP_DELIVERY_STATUS = Object.freeze({
  PENDING: "pending",
  QUEUED: "queued",
  DISPLAYED: "displayed",
  READ: "read",
  DISMISSED: "dismissed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
});

/** Prioridade de exibição (alinha ao contrato global S5.1). */
export const S7_POPUP_PRIORITY = Object.freeze({
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  CRITICAL: "critical",
});

/** Superfícies de UI previstas (reaproveitamento futuro). */
export const S7_POPUP_UI_SURFACE = Object.freeze({
  TOAST: "toast",
  MODAL: "modal",
  INLINE_ALERT: "inline_alert",
  OVERLAY: "overlay",
});

/** Tabela de persistência / rastreio (S5.7). */
export const S7_POPUP_DELIVERIES_TABLE = "s7_notification_popup_deliveries";

/** Provider interno (entrega in-app, sem API externa). */
export const S7_POPUP_OFFICIAL_PROVIDER = "s7_popup_in_app";
