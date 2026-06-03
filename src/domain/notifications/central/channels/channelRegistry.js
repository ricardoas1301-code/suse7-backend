// =============================================================================
// S7 — Registro Oficial de Canais (Fase S5.3)
// Fonte ÚNICA de verdade dos canais de comunicação do Suse7.
//
// Todo canal usado pelo Motor Central DEVE estar aqui. Nenhum módulo pode usar
// canal fora deste registro. Camada de INFRAESTRUTURA: sem regra de negócio,
// sem template, sem notificação específica, sem marketplace/seller hardcoded.
//
// Os códigos canônicos espelham S7_NOTIFICATION_CHANNEL (constants/channels.js),
// estendidos com os canais visuais/externos futuros (popup, banner, webhook).
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";

/**
 * Tipo do canal (natureza técnica).
 * @type {const}
 */
export const S7_CHANNEL_TYPE = Object.freeze({
  IN_APP: "in_app", // dentro do app (sininho/inbox)
  EXTERNAL: "external", // sai do app via provider externo (email/whatsapp/push)
  VISUAL: "visual", // overlay visual interno (popup/banner)
  WEBHOOK: "webhook", // integração HTTP de saída
});

/**
 * Estado do canal no registro.
 * @type {const}
 */
export const S7_CHANNEL_STATUS = Object.freeze({
  ATIVO: "ativo",
  INATIVO: "inativo",
  EXPERIMENTAL: "experimental",
  FUTURO: "futuro",
  DESABILITADO: "desabilitado",
});

/**
 * Modo de entrega.
 * @type {const}
 */
export const S7_CHANNEL_DELIVERY_MODE = Object.freeze({
  IMMEDIATE: "immediate", // entregue na hora pelo provider
  ASYNC: "async", // enfileirado e processado por worker
  NONE: "none", // ainda sem mecânica de entrega (canal futuro)
});

/**
 * @typedef {Object} S7ChannelCapabilities
 * @property {boolean} immediate_delivery
 * @property {boolean} async_delivery
 * @property {boolean} needs_queue
 * @property {boolean} needs_recipient
 * @property {boolean} supports_template
 * @property {boolean} supports_history
 */

/**
 * @typedef {Object} S7ChannelDefinition
 * @property {string} code
 * @property {string} name
 * @property {string} type
 * @property {string} status
 * @property {boolean} available  — apto a entregar agora
 * @property {boolean} supported  — reconhecido pelo motor (registrado)
 * @property {string} delivery_mode
 * @property {string[]} aliases
 * @property {S7ChannelCapabilities} capabilities
 * @property {string} description
 */

/** @param {Partial<S7ChannelCapabilities>} caps @returns {S7ChannelCapabilities} */
function caps(c) {
  return {
    immediate_delivery: c.immediate_delivery ?? false,
    async_delivery: c.async_delivery ?? false,
    needs_queue: c.needs_queue ?? false,
    needs_recipient: c.needs_recipient ?? false,
    supports_template: c.supports_template ?? false,
    supports_history: c.supports_history ?? false,
  };
}

/**
 * Registro oficial. `supported` = reconhecido/registrado; `available` = entrega já.
 * @type {Readonly<Record<string, S7ChannelDefinition>>}
 */
export const S7_CHANNEL_REGISTRY = Object.freeze({
  [S7_NOTIFICATION_CHANNEL.IN_APP]: {
    code: S7_NOTIFICATION_CHANNEL.IN_APP,
    name: "Central Sininho",
    type: S7_CHANNEL_TYPE.IN_APP,
    status: S7_CHANNEL_STATUS.ATIVO,
    available: true,
    supported: true,
    delivery_mode: S7_CHANNEL_DELIVERY_MODE.IMMEDIATE,
    aliases: ["sininho", "bell", "inbox"],
    capabilities: caps({
      immediate_delivery: true,
      needs_recipient: true,
      supports_template: true,
      supports_history: true,
    }),
    description: "Sininho / inbox in-app (entrega imediata, com histórico)",
  },
  [S7_NOTIFICATION_CHANNEL.EMAIL]: {
    code: S7_NOTIFICATION_CHANNEL.EMAIL,
    name: "E-mail",
    type: S7_CHANNEL_TYPE.EXTERNAL,
    status: S7_CHANNEL_STATUS.ATIVO,
    available: true,
    supported: true,
    delivery_mode: S7_CHANNEL_DELIVERY_MODE.ASYNC,
    aliases: ["e-mail", "mail"],
    capabilities: caps({
      async_delivery: true,
      needs_queue: true,
      needs_recipient: true,
      supports_template: true,
      supports_history: true,
    }),
    description: "E-mail via provider externo (outbox + worker)",
  },
  [S7_NOTIFICATION_CHANNEL.WHATSAPP]: {
    code: S7_NOTIFICATION_CHANNEL.WHATSAPP,
    name: "WhatsApp",
    type: S7_CHANNEL_TYPE.EXTERNAL,
    status: S7_CHANNEL_STATUS.ATIVO,
    available: true,
    supported: true,
    delivery_mode: S7_CHANNEL_DELIVERY_MODE.ASYNC,
    aliases: ["zapi", "wpp", "whats"],
    capabilities: caps({
      async_delivery: true,
      needs_queue: true,
      needs_recipient: true,
      supports_template: true,
      supports_history: true,
    }),
    description: "WhatsApp via provider abstraído (Z-API/Meta/…) + outbox",
  },
  [S7_NOTIFICATION_CHANNEL.PUSH]: {
    code: S7_NOTIFICATION_CHANNEL.PUSH,
    name: "Push Mobile",
    type: S7_CHANNEL_TYPE.EXTERNAL,
    status: S7_CHANNEL_STATUS.FUTURO,
    available: false,
    supported: true,
    delivery_mode: S7_CHANNEL_DELIVERY_MODE.NONE,
    aliases: ["webpush", "mobile_push"],
    capabilities: caps({
      async_delivery: true,
      needs_queue: true,
      needs_recipient: true,
      supports_template: true,
    }),
    description: "Push mobile (futuro — sem provider nesta fase)",
  },
  popup: {
    code: "popup",
    name: "Pop-up",
    type: S7_CHANNEL_TYPE.VISUAL,
    status: S7_CHANNEL_STATUS.FUTURO,
    available: false,
    supported: true,
    delivery_mode: S7_CHANNEL_DELIVERY_MODE.NONE,
    aliases: ["pop-up", "modal"],
    capabilities: caps({
      immediate_delivery: true,
      supports_template: true,
    }),
    description: "Pop-up interno (futuro)",
  },
  banner: {
    code: "banner",
    name: "Banner Interno",
    type: S7_CHANNEL_TYPE.VISUAL,
    status: S7_CHANNEL_STATUS.FUTURO,
    available: false,
    supported: true,
    delivery_mode: S7_CHANNEL_DELIVERY_MODE.NONE,
    aliases: ["banner_interno"],
    capabilities: caps({
      immediate_delivery: true,
      supports_template: true,
    }),
    description: "Banner interno (futuro)",
  },
  webhook: {
    code: "webhook",
    name: "Webhook",
    type: S7_CHANNEL_TYPE.WEBHOOK,
    status: S7_CHANNEL_STATUS.FUTURO,
    available: false,
    supported: true,
    delivery_mode: S7_CHANNEL_DELIVERY_MODE.NONE,
    aliases: ["callback", "http_webhook"],
    capabilities: caps({
      async_delivery: true,
      needs_queue: true,
      needs_recipient: true,
      supports_history: true,
    }),
    description: "Webhook externo de saída (futuro)",
  },
});

/** alias → código canônico (resolvido uma vez). */
const ALIAS_TO_CODE = (() => {
  /** @type {Record<string, string>} */
  const map = {};
  for (const def of Object.values(S7_CHANNEL_REGISTRY)) {
    map[def.code] = def.code;
    for (const alias of def.aliases) map[alias] = def.code;
  }
  return Object.freeze(map);
})();

/**
 * Resolve um identificador (código ou alias, ex.: "sininho") para o código canônico.
 * @param {string} channel
 * @returns {string | null}
 */
export function resolveCanonicalChannelCode(channel) {
  const key = String(channel ?? "").trim().toLowerCase();
  return ALIAS_TO_CODE[key] ?? null;
}

/**
 * @param {string} channel
 * @returns {S7ChannelDefinition | null}
 */
export function getChannelDefinition(channel) {
  const code = resolveCanonicalChannelCode(channel);
  return code ? S7_CHANNEL_REGISTRY[code] : null;
}

/** @param {string} channel — registrado/reconhecido pelo motor */
export function isRegisteredChannel(channel) {
  return getChannelDefinition(channel) != null;
}

/** @param {string} channel — reconhecido pelo motor (supported) */
export function isChannelSupported(channel) {
  return getChannelDefinition(channel)?.supported === true;
}

/** @param {string} channel — apto a entregar agora (available + status ativo) */
export function isChannelAvailable(channel) {
  const def = getChannelDefinition(channel);
  return def?.available === true && def?.status === S7_CHANNEL_STATUS.ATIVO;
}

/** @param {string} channel */
export function getChannelCapabilities(channel) {
  return getChannelDefinition(channel)?.capabilities ?? null;
}

/** @returns {string[]} todos os códigos registrados */
export function listRegisteredChannels() {
  return Object.values(S7_CHANNEL_REGISTRY).map((d) => d.code);
}

/** @returns {string[]} códigos aptos a entregar agora */
export function listAvailableChannels() {
  return Object.values(S7_CHANNEL_REGISTRY)
    .filter((d) => d.available && d.status === S7_CHANNEL_STATUS.ATIVO)
    .map((d) => d.code);
}

/** @param {string} status @returns {string[]} */
export function listChannelsByStatus(status) {
  const s = String(status ?? "").trim().toLowerCase();
  return Object.values(S7_CHANNEL_REGISTRY)
    .filter((d) => d.status === s)
    .map((d) => d.code);
}

/**
 * Filtra uma lista de canais, mantendo apenas os registrados e disponíveis.
 * Usado pelo Dispatcher para eliminar dependências implícitas de canal.
 * @param {string[]} channels
 * @returns {{ allowed: string[]; rejected: string[] }}
 */
export function filterRegisteredAvailableChannels(channels) {
  /** @type {string[]} */ const allowed = [];
  /** @type {string[]} */ const rejected = [];
  const seen = new Set();
  for (const raw of Array.isArray(channels) ? channels : []) {
    const code = resolveCanonicalChannelCode(raw);
    if (code && isChannelAvailable(code) && !seen.has(code)) {
      seen.add(code);
      allowed.push(code);
    } else {
      rejected.push(String(raw));
    }
  }
  return { allowed, rejected };
}
