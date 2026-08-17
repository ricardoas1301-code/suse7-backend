// =============================================================================
// S7 — Contrato Global de Comunicação (Fase S5.1)
// Constantes oficiais do Communication Event Model.
// Camada de INFRAESTRUTURA: sem regra de negócio, sem template, sem evento
// específico. Apenas o vocabulário canônico do contrato.
// =============================================================================

/**
 * Versão atual do Contrato Global de Comunicação.
 * Toda publicação carimba esta versão (coluna contract_version) para permitir
 * evolução do envelope sem quebrar eventos antigos.
 * @type {number}
 */
export const S7_COMMUNICATION_CONTRACT_VERSION = 1;

/**
 * Versões reconhecidas (para validação e compatibilidade retroativa).
 * @type {ReadonlyArray<number>}
 */
export const S7_COMMUNICATION_SUPPORTED_CONTRACT_VERSIONS = Object.freeze([1]);

/** @param {unknown} version */
export function isSupportedContractVersion(version) {
  const n = Number(version);
  return Number.isInteger(n) && S7_COMMUNICATION_SUPPORTED_CONTRACT_VERSIONS.includes(n);
}

/**
 * Prioridade de comunicação (sinal de urgência de entrega).
 * Distinta de `severity` (sinal de negócio: info/warning/critical).
 * @type {const}
 */
export const S7_COMMUNICATION_PRIORITY = Object.freeze({
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  CRITICAL: "critical",
});

const PRIORITY_SET = new Set(Object.values(S7_COMMUNICATION_PRIORITY));

/** @param {string} priority */
export function isValidCommunicationPriority(priority) {
  return PRIORITY_SET.has(String(priority ?? "").trim());
}

/**
 * Mapa padrão severity → prioridade (default quando o publisher não informa).
 * Mantém coerência com os níveis de severidade já usados pelo motor.
 * @type {Readonly<Record<string, string>>}
 */
const SEVERITY_TO_PRIORITY = Object.freeze({
  info: S7_COMMUNICATION_PRIORITY.NORMAL,
  warning: S7_COMMUNICATION_PRIORITY.HIGH,
  critical: S7_COMMUNICATION_PRIORITY.CRITICAL,
  // tolerância a severidades legadas
  important: S7_COMMUNICATION_PRIORITY.HIGH,
  medium: S7_COMMUNICATION_PRIORITY.NORMAL,
});

/**
 * Resolve a prioridade a partir da severidade quando o publisher não informa.
 * @param {string} [severity]
 * @returns {string}
 */
export function resolveDefaultPriority(severity) {
  const key = String(severity ?? "").trim().toLowerCase();
  return SEVERITY_TO_PRIORITY[key] ?? S7_COMMUNICATION_PRIORITY.NORMAL;
}

/**
 * Defaults de deduplicação por janela.
 * - DISABLED: janela 0 ou ausência de dedupe_key desliga o mecanismo.
 * - DEFAULT_WINDOW_SECONDS: janela padrão aplicada quando há dedupe_key sem janela explícita.
 * - MAX_WINDOW_SECONDS: teto de segurança (24h) para evitar dedupe perpétuo indevido.
 */
export const S7_COMMUNICATION_DEDUPE = Object.freeze({
  DEFAULT_WINDOW_SECONDS: 300,
  MAX_WINDOW_SECONDS: 86400,
});

/**
 * Normaliza a janela de dedupe recebida do publisher.
 * @param {unknown} windowSeconds
 * @param {boolean} hasDedupeKey
 * @returns {number} segundos efetivos (0 = desativado)
 */
export function normalizeDedupeWindowSeconds(windowSeconds, hasDedupeKey) {
  if (!hasDedupeKey) return 0;
  const raw = Number(windowSeconds);
  if (!Number.isFinite(raw)) return S7_COMMUNICATION_DEDUPE.DEFAULT_WINDOW_SECONDS;
  if (raw <= 0) return 0;
  return Math.min(Math.floor(raw), S7_COMMUNICATION_DEDUPE.MAX_WINDOW_SECONDS);
}
