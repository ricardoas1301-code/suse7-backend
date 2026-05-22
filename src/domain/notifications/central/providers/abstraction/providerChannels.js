// =============================================================================
// Canais extensíveis — Fase 3.5C (implementação inicial: whatsapp)
// =============================================================================

export const S7_PROVIDER_CHANNEL = Object.freeze({
  WHATSAPP: "whatsapp",
  EMAIL: "email",
  IN_APP: "in_app",
  PUSH: "push",
  WEBHOOK: "webhook",
});

/** Canais com adapter registrado nesta fase. */
export const S7_PROVIDER_CHANNELS_IMPLEMENTED = Object.freeze([S7_PROVIDER_CHANNEL.WHATSAPP]);

/**
 * @param {string} channel
 */
export function isImplementedProviderChannel(channel) {
  return S7_PROVIDER_CHANNELS_IMPLEMENTED.includes(String(channel ?? "").trim());
}
