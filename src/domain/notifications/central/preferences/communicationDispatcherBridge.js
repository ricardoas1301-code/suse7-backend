// =============================================================================
// S7 — Preferências de Comunicação (Fase S5.9) — ponte com Dispatcher
// Documenta a cadeia oficial sem duplicar execução.
// =============================================================================

/**
 * Cadeia oficial de decisão de entrega (Motor Central).
 * Toda entrega passa por preferências antes de destinatários e canais.
 */
export function describeCommunicationDispatcherPipeline() {
  return {
    entry: "runCentralDispatcher",
    engine: "runNotificationActionsEngine",
    steps: [
      {
        order: 1,
        layer: "preferences",
        resolver: "resolveNotificationActionPreferences",
        delegate: "resolveNotificationPreferences",
        output: "enabledChannels, mandatory, channels map",
      },
      {
        order: 2,
        layer: "channels",
        resolver: "resolveNotificationChannels",
        inputs: ["catalog.supportedChannels", "prefs.enabledChannels", "channelRegistry.filterRegisteredAvailableChannels"],
      },
      {
        order: 3,
        layer: "templates",
        resolver: "resolveNotificationTemplate",
      },
      {
        order: 4,
        layer: "recipients",
        resolver: "resolveNotificationActionRecipients",
        delegate: "resolveCentralRecipients",
        inputs: ["event_delivery_rules", "recipient_scopes", "profile_fallback"],
      },
      {
        order: 5,
        layer: "delivery",
        resolver: "getNotificationDeliveryProvider",
        outputs: ["s7_notification_dispatches", "outbox tables por canal externo"],
      },
    ],
    invariant:
      "Nenhum canal é entregue sem passar por resolveNotificationPreferences (exceto manual_recipients_by_channel explícito).",
  };
}
