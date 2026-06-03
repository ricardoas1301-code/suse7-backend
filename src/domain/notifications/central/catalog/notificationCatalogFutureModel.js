// =============================================================================
// S7 — Catálogo (S5.11) — modelo futuro de notificação (esqueleto)
// =============================================================================

/**
 * @returns {Readonly<Record<string, { type: string; required: boolean; description: string }>>}
 */
export function describeFutureNotificationDefinitionSchema() {
  return Object.freeze({
    code: {
      type: "string",
      required: true,
      description: "Código único da notificação no catálogo (ex.: billing.payment.failed)",
    },
    name: { type: "string", required: true, description: "Nome legível para UI/admin" },
    category_code: {
      type: "string",
      required: true,
      description: "Categoria oficial (s7_notification_categories)",
    },
    type_key: {
      type: "string",
      required: true,
      description: "Tipo dentro da categoria (s7_notification_event_types)",
    },
    priority: {
      type: "enum",
      required: true,
      description: "info | warning | high | critical",
    },
    mandatory_tier: {
      type: "enum",
      required: true,
      description: "mandatory | optional",
    },
    allowed_channels: {
      type: "string[]",
      required: true,
      description: "Canais permitidos (Registro S5.3)",
    },
    template_key: {
      type: "string",
      required: false,
      description: "Referência Central de Templates S5.4",
    },
    origin_module: {
      type: "string",
      required: false,
      description: "Módulo publicador (billing, marketplace, …)",
    },
    dispatch_rules_ref: {
      type: "object",
      required: false,
      description: "Referência futura a regras de disparo — não implementado S5.11",
    },
  });
}
