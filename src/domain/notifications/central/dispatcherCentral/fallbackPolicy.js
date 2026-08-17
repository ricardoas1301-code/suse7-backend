// =============================================================================
// S7 — Dispatcher Central (Fase S5.2)
// Política de fallback entre canais — ESTRUTURA preparada, dirigida por env.
//
// Não há regra de negócio hardcoded: a cadeia de fallback é totalmente
// configurável por canal e default vazio (sem fallback). O dispatcher fica
// PREPARADO para fallback; a ativação real é decisão de configuração/fase futura.
//
// Ex.: S7_DISPATCH_FALLBACK_WHATSAPP="email,in_app"
// =============================================================================

import {
  isChannelSupportedNow,
  resolveCanonicalChannel,
} from "./channelCatalog.js";

/**
 * Lê a cadeia bruta de fallback configurada para um canal (CSV em env).
 * @param {string} channel canônico
 * @returns {string[]} canais canônicos na ordem configurada (pode ser vazio)
 */
function readConfiguredFallbackChain(channel) {
  const ch = String(channel ?? "").trim().toUpperCase();
  const raw = process.env[`S7_DISPATCH_FALLBACK_${ch}`];
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((c) => resolveCanonicalChannel(c))
    .filter((c) => typeof c === "string" && c.length > 0);
}

/**
 * Resolve a cadeia de fallback efetiva de um canal de origem.
 * Aplica saneamento: remove o próprio canal, duplicatas, canais não suportados,
 * e (opcionalmente) restringe aos canais disponíveis para o evento.
 *
 * @param {string} originChannel
 * @param {{ availableChannels?: string[] }} [options]
 * @returns {{ origin: string | null; chain: string[]; enabled: boolean }}
 */
export function resolveChannelFallbackChain(originChannel, options = {}) {
  const origin = resolveCanonicalChannel(originChannel);
  if (!origin) return { origin: null, chain: [], enabled: false };

  const available =
    Array.isArray(options.availableChannels) && options.availableChannels.length > 0
      ? new Set(
          options.availableChannels
            .map((c) => resolveCanonicalChannel(c))
            .filter((c) => typeof c === "string")
        )
      : null;

  const seen = new Set([origin]);
  /** @type {string[]} */
  const chain = [];

  for (const candidate of readConfiguredFallbackChain(origin)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!isChannelSupportedNow(candidate)) continue;
    if (available && !available.has(candidate)) continue;
    chain.push(candidate);
  }

  return { origin, chain, enabled: chain.length > 0 };
}

/**
 * Próximo canal de fallback após uma falha, dado o que já foi tentado.
 * @param {string} originChannel
 * @param {{ attemptedChannels?: string[]; availableChannels?: string[] }} [options]
 * @returns {string | null}
 */
export function resolveNextFallbackChannel(originChannel, options = {}) {
  const { chain } = resolveChannelFallbackChain(originChannel, {
    availableChannels: options.availableChannels,
  });
  const attempted = new Set(
    (Array.isArray(options.attemptedChannels) ? options.attemptedChannels : [])
      .map((c) => resolveCanonicalChannel(c))
      .filter((c) => typeof c === "string")
  );
  for (const ch of chain) {
    if (!attempted.has(ch)) return ch;
  }
  return null;
}
