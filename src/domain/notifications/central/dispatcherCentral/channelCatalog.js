// =============================================================================
// S7 — Dispatcher Central (Fase S5.2) — catálogo/roteador de canais.
//
// Fase S5.3: este catálogo deixou de ter dados próprios e passou a ser uma
// VISÃO DERIVADA do Registro Oficial de Canais (channels/channelRegistry.js),
// que é a fonte única de verdade. A API pública da S5.2 é preservada para
// não quebrar consumidores (Dispatcher Central, testes, barrels).
// =============================================================================

import {
  S7_CHANNEL_REGISTRY,
  S7_CHANNEL_DELIVERY_MODE,
  resolveCanonicalChannelCode,
  getChannelDefinition,
  isChannelAvailable,
  listAvailableChannels,
} from "../channels/channelRegistry.js";

/**
 * Modos de entrega (vocabulário legado da S5.2 — mantido por compatibilidade).
 * Mapeia o Registro: async → queued.
 * @type {const}
 */
export const S7_DISPATCH_DELIVERY_MODE = Object.freeze({
  IMMEDIATE: "immediate",
  QUEUED: "queued",
  NONE: "none",
});

/** @param {string} registryMode */
function toLegacyDeliveryMode(registryMode) {
  if (registryMode === S7_CHANNEL_DELIVERY_MODE.IMMEDIATE) return S7_DISPATCH_DELIVERY_MODE.IMMEDIATE;
  if (registryMode === S7_CHANNEL_DELIVERY_MODE.ASYNC) return S7_DISPATCH_DELIVERY_MODE.QUEUED;
  return S7_DISPATCH_DELIVERY_MODE.NONE;
}

/** @param {import("../channels/channelRegistry.js").S7ChannelDefinition} def */
function toCatalogEntry(def) {
  return {
    channel: def.code,
    aliases: def.aliases,
    supported_now: def.available === true,
    delivery_mode: toLegacyDeliveryMode(def.delivery_mode),
    description: def.description,
  };
}

/**
 * Catálogo derivado do Registro Oficial (formato legado S5.2).
 * @type {Readonly<Record<string, { channel: string; aliases: string[]; supported_now: boolean; delivery_mode: string; description: string }>>}
 */
export const S7_DISPATCH_CHANNEL_CATALOG = Object.freeze(
  Object.fromEntries(
    Object.values(S7_CHANNEL_REGISTRY).map((def) => [def.code, toCatalogEntry(def)])
  )
);

/**
 * Normaliza um identificador de canal (aceita aliases como "sininho").
 * @param {string} channel
 * @returns {string | null}
 */
export function resolveCanonicalChannel(channel) {
  return resolveCanonicalChannelCode(channel);
}

/**
 * Retorna a entrada do catálogo (formato legado) para um canal/alias.
 * @param {string} channel
 */
export function getChannelCatalogEntry(channel) {
  const def = getChannelDefinition(channel);
  return def ? toCatalogEntry(def) : null;
}

/**
 * @param {string} channel
 * @returns {boolean} se o canal está apto a entregar nesta fase
 */
export function isChannelSupportedNow(channel) {
  return isChannelAvailable(channel);
}

/**
 * Canais aptos a entregar nesta fase (lista canônica).
 * @returns {string[]}
 */
export function listSupportedChannels() {
  return listAvailableChannels();
}

/**
 * Filtra/roteia uma lista de canais desejados, separando suportados de futuros.
 * Não decide preferências (isso é do channelResolver) — só roteamento técnico.
 * @param {string[]} channels
 * @returns {{ routed: string[]; deferred: string[]; unknown: string[] }}
 */
export function routeChannels(channels) {
  /** @type {string[]} */ const routed = [];
  /** @type {string[]} */ const deferred = [];
  /** @type {string[]} */ const unknown = [];

  for (const raw of Array.isArray(channels) ? channels : []) {
    const canonical = resolveCanonicalChannelCode(raw);
    if (!canonical) {
      unknown.push(String(raw));
      continue;
    }
    if (isChannelAvailable(canonical)) routed.push(canonical);
    else deferred.push(canonical);
  }

  return { routed, deferred, unknown };
}
