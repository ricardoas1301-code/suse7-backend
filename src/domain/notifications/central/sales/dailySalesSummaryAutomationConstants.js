// =============================================================================
// Constantes — Resumo de vendas do dia (SALES:DAILY_SALES_SUMMARY)
// =============================================================================

import { S7_NOTIFICATION_CATEGORY } from "../constants/categories.js";

export const DAILY_SALES_SUMMARY_CATEGORY = S7_NOTIFICATION_CATEGORY.SALES;
export const DAILY_SALES_SUMMARY_TYPE = "DAILY_SALES_SUMMARY";
export const DAILY_SALES_SUMMARY_TIMEZONE = "America/Sao_Paulo";
export const DAILY_SALES_SUMMARY_TEMPLATE_KEY = "sales.daily.summary";

/** Tolerância do motor para bater horário agendado (minutos). */
export const DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN = 3;

export const DEFAULT_DAILY_SALES_SUMMARY_CONFIG = Object.freeze({
  channels: {
    whatsapp: true,
    email: true,
    in_app: true,
    popup: true,
  },
  weekdays: [1, 2, 3, 4, 5],
  times: ["18:00"],
  timezone: DAILY_SALES_SUMMARY_TIMEZONE,
});

export const WEEKDAY_LABELS_PT = Object.freeze([
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
]);

export const WEEKDAY_LABELS_SHORT_PT = Object.freeze(["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]);
