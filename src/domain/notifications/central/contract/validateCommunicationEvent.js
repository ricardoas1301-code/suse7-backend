// =============================================================================
// S7 — Contrato Global de Comunicação (Fase S5.1)
// Validator oficial do Communication Event Model.
//
// Valida o envelope contra o contrato canônico. Retorna códigos de erro
// estáveis e compatíveis com os já usados pelo motor (MISSING_SELLER_ID,
// INVALID_CATEGORY, INVALID_TYPE) para não quebrar publishers existentes.
//
// Camada de INFRAESTRUTURA: sem regra de negócio.
// =============================================================================

import { isValidNotificationCategory } from "../constants/categories.js";
import {
  isValidCommunicationPriority,
  isSupportedContractVersion,
} from "../constants/communicationContract.js";
import { isValidCentralNotificationType } from "../constants/eventTypes.js";

/**
 * Valida o envelope do Communication Event Model.
 *
 * @param {Record<string, any>} envelope
 * @returns {{ ok: boolean; errors: string[]; primaryError: string | null }}
 */
export function validateCommunicationEvent(envelope) {
  /** @type {string[]} */
  const errors = [];

  const env = envelope && typeof envelope === "object" ? envelope : {};

  const sellerId = String(env.seller_id ?? "").trim();
  const category = String(env.category ?? "").trim();
  const type = String(env.type ?? "").trim();

  // Ordem de checagem espelha o contrato legado para compatibilidade de erros.
  if (!sellerId) {
    errors.push("MISSING_SELLER_ID");
  }
  if (!isValidNotificationCategory(category)) {
    errors.push("INVALID_CATEGORY");
  } else if (!isValidCentralNotificationType(category, type)) {
    errors.push("INVALID_TYPE");
  }

  if (!isSupportedContractVersion(env.contract_version)) {
    errors.push("UNSUPPORTED_CONTRACT_VERSION");
  }

  if (env.priority != null && !isValidCommunicationPriority(env.priority)) {
    errors.push("INVALID_PRIORITY");
  }

  if (
    env.payload != null &&
    (typeof env.payload !== "object" || Array.isArray(env.payload))
  ) {
    errors.push("INVALID_PAYLOAD");
  }

  if (
    env.metadata != null &&
    (typeof env.metadata !== "object" || Array.isArray(env.metadata))
  ) {
    errors.push("INVALID_METADATA");
  }

  if (env.dedupe_key != null && String(env.dedupe_key).trim() === "") {
    errors.push("INVALID_DEDUPE_KEY");
  }

  if (
    env.dedupe_window_seconds != null &&
    (!Number.isFinite(Number(env.dedupe_window_seconds)) ||
      Number(env.dedupe_window_seconds) < 0)
  ) {
    errors.push("INVALID_DEDUPE_WINDOW");
  }

  return {
    ok: errors.length === 0,
    errors,
    primaryError: errors[0] ?? null,
  };
}
