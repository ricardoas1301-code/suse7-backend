// =============================================================================
// S7 — Contrato Global de Comunicação (Fase S5.1)
// Metadata padronizada e extensível do Communication Event Model.
//
// `payload`  = dados de negócio do evento (livres por tipo).
// `metadata` = contexto técnico padronizado do contrato (origem, prioridade,
//              trace, snapshot de tenant, contrato). Extensível via `custom`
//              sem quebra de compatibilidade.
//
// Camada de INFRAESTRUTURA: sem regra de negócio.
// =============================================================================

import {
  S7_COMMUNICATION_CONTRACT_VERSION,
  resolveDefaultPriority,
} from "../constants/communicationContract.js";

/**
 * Chaves reservadas do envelope de metadata (não podem ser sobrescritas por `custom`).
 * @type {ReadonlyArray<string>}
 */
export const S7_COMMUNICATION_METADATA_RESERVED_KEYS = Object.freeze([
  "contract_version",
  "priority",
  "origin",
  "tenant",
  "trace",
  "emitted_at",
]);

/**
 * Constrói o envelope de metadata padronizado.
 * Determinístico e puro (não acessa I/O), exceto `emitted_at` (timestamp do build),
 * que pode ser fixado via `input.emittedAt` para idempotência/testes.
 *
 * @param {{
 *   contractVersion?: number;
 *   priority?: string | null;
 *   severity?: string | null;
 *   sourceModule?: string | null;
 *   sourceEvent?: string | null;
 *   correlationId?: string | null;
 *   idempotencyKey?: string | null;
 *   dedupeKey?: string | null;
 *   sellerId?: string | null;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 *   entityType?: string | null;
 *   entityId?: string | null;
 *   emittedAt?: string | null;
 *   custom?: Record<string, unknown> | null;
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildStandardCommunicationMetadata(input = {}) {
  const custom =
    input.custom && typeof input.custom === "object" && !Array.isArray(input.custom)
      ? input.custom
      : {};

  // `custom` nunca sobrescreve chaves reservadas do contrato.
  const sanitizedCustom = { ...custom };
  for (const reserved of S7_COMMUNICATION_METADATA_RESERVED_KEYS) {
    if (reserved in sanitizedCustom) delete sanitizedCustom[reserved];
  }

  const priority =
    input.priority != null && String(input.priority).trim() !== ""
      ? String(input.priority).trim()
      : resolveDefaultPriority(input.severity ?? undefined);

  return {
    contract_version: input.contractVersion ?? S7_COMMUNICATION_CONTRACT_VERSION,
    priority,
    emitted_at: input.emittedAt ?? new Date().toISOString(),
    origin: {
      source_module: input.sourceModule ?? null,
      source_event: input.sourceEvent ?? null,
    },
    trace: {
      correlation_id: input.correlationId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      dedupe_key: input.dedupeKey ?? null,
    },
    tenant: {
      seller_id: input.sellerId ?? null,
      marketplace: input.marketplace ?? null,
      marketplace_account_id: input.marketplaceAccountId ?? null,
      seller_company_id: input.sellerCompanyId ?? null,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
    },
    custom: sanitizedCustom,
  };
}

/**
 * Mescla metadata recebida do publisher com o envelope padrão, preservando o
 * envelope canônico e empurrando chaves desconhecidas para `custom`.
 *
 * @param {Record<string, unknown> | null | undefined} incoming
 * @param {Record<string, unknown>} standard
 * @returns {Record<string, unknown>}
 */
export function mergeCommunicationMetadata(incoming, standard) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return standard;
  }

  /** @type {Record<string, unknown>} */
  const extraCustom = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (S7_COMMUNICATION_METADATA_RESERVED_KEYS.includes(key)) continue;
    if (key === "custom") continue;
    extraCustom[key] = value;
  }

  const incomingCustom =
    incoming.custom && typeof incoming.custom === "object" && !Array.isArray(incoming.custom)
      ? incoming.custom
      : {};

  return {
    ...standard,
    custom: {
      .../** @type {Record<string, unknown>} */ (standard.custom ?? {}),
      ...extraCustom,
      ...incomingCustom,
    },
  };
}
