// =============================================================================
// Canais de entrega — motor central
// =============================================================================

/** @type {const} */
export const S7_NOTIFICATION_CHANNEL = Object.freeze({
  IN_APP: "in_app",
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  PUSH: "push",
});

const CHANNEL_SET = new Set(Object.values(S7_NOTIFICATION_CHANNEL));

/** @param {string} channel */
export function isValidNotificationChannel(channel) {
  return CHANNEL_SET.has(String(channel ?? "").trim());
}

/** @type {ReadonlyArray<string>} */
export const S7_NOTIFICATION_CHANNEL_ORDER = [
  S7_NOTIFICATION_CHANNEL.IN_APP,
  S7_NOTIFICATION_CHANNEL.EMAIL,
  S7_NOTIFICATION_CHANNEL.WHATSAPP,
  S7_NOTIFICATION_CHANNEL.PUSH,
];
