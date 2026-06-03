// =============================================================================
// S7 — Dispatcher Central (Fase S5.2) — catálogo/roteador de canais.
// Catálogo autônomo nesta fase; na S5.3 passa a derivar do Registro Oficial.
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";

/** @type {const} */
export const S7_DISPATCH_DELIVERY_MODE = Object.freeze({
  IMMEDIATE: "immediate",
  QUEUED: "queued",
  NONE: "none",
});

/**
 * @type {Readonly<Record<string, { channel: string; aliases: string[]; supported_now: boolean; delivery_mode: string; description: string }>>}
 */
export const S7_DISPATCH_CHANNEL_CATALOG = Object.freeze({
  [S7_NOTIFICATION_CHANNEL.IN_APP]: {
    channel: S7_NOTIFICATION_CHANNEL.IN_APP,
    aliases: ["sininho", "bell", "inbox"],
    supported_now: true,
    delivery_mode: S7_DISPATCH_DELIVERY_MODE.IMMEDIATE,
    description: "Sininho / inbox in-app (entrega imediata)",
  },
  [S7_NOTIFICATION_CHANNEL.EMAIL]: {
    channel: S7_NOTIFICATION_CHANNEL.EMAIL,
    aliases: ["e-mail", "mail"],
    supported_now: true,
    delivery_mode: S7_DISPATCH_DELIVERY_MODE.QUEUED,
    description: "E-mail via outbox + worker",
  },
  [S7_NOTIFICATION_CHANNEL.WHATSAPP]: {
    channel: S7_NOTIFICATION_CHANNEL.WHATSAPP,
    aliases: ["zapi", "wpp", "whats"],
    supported_now: true,
    delivery_mode: S7_DISPATCH_DELIVERY_MODE.QUEUED,
    description: "WhatsApp via outbox",
  },
  [S7_NOTIFICATION_CHANNEL.PUSH]: {
    channel: S7_NOTIFICATION_CHANNEL.PUSH,
    aliases: ["webpush", "mobile_push"],
    supported_now: false,
    delivery_mode: S7_DISPATCH_DELIVERY_MODE.NONE,
    description: "Push mobile (futuro)",
  },
  popup: {
    channel: "popup",
    aliases: ["pop-up", "modal"],
    supported_now: false,
    delivery_mode: S7_DISPATCH_DELIVERY_MODE.NONE,
    description: "Pop-up interno (futuro)",
  },
  banner: {
    channel: "banner",
    aliases: ["banner_interno"],
    supported_now: false,
    delivery_mode: S7_DISPATCH_DELIVERY_MODE.NONE,
    description: "Banner interno (futuro)",
  },
  webhook: {
    channel: "webhook",
    aliases: ["callback", "http_webhook"],
    supported_now: false,
    delivery_mode: S7_DISPATCH_DELIVERY_MODE.NONE,
    description: "Webhook externo (futuro)",
  },
});

const ALIAS_TO_CODE = (() => {
  /** @type {Record<string, string>} */
  const map = {};
  for (const entry of Object.values(S7_DISPATCH_CHANNEL_CATALOG)) {
    map[entry.channel] = entry.channel;
    for (const alias of entry.aliases) map[alias] = entry.channel;
  }
  return Object.freeze(map);
})();

/** @param {string} channel @returns {string | null} */
export function resolveCanonicalChannel(channel) {
  const key = String(channel ?? "").trim().toLowerCase();
  return ALIAS_TO_CODE[key] ?? null;
}

/** @param {string} channel */
export function getChannelCatalogEntry(channel) {
  const code = resolveCanonicalChannel(channel);
  return code ? S7_DISPATCH_CHANNEL_CATALOG[code] : null;
}

/** @param {string} channel */
export function isChannelSupportedNow(channel) {
  return getChannelCatalogEntry(channel)?.supported_now === true;
}

/** @returns {string[]} */
export function listSupportedChannels() {
  return Object.values(S7_DISPATCH_CHANNEL_CATALOG)
    .filter((e) => e.supported_now)
    .map((e) => e.channel);
}

/** @param {string[]} channels */
export function routeChannels(channels) {
  /** @type {string[]} */ const routed = [];
  /** @type {string[]} */ const deferred = [];
  /** @type {string[]} */ const unknown = [];

  for (const raw of Array.isArray(channels) ? channels : []) {
    const canonical = resolveCanonicalChannel(raw);
    if (!canonical) {
      unknown.push(String(raw));
      continue;
    }
    if (isChannelSupportedNow(canonical)) routed.push(canonical);
    else deferred.push(canonical);
  }

  return { routed, deferred, unknown };
}
