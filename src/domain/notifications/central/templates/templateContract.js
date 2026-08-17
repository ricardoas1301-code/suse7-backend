// =============================================================================
// S7 — Central de Templates (Fase S5.4)
// Contrato oficial de um template de comunicação.
//
// Camada de INFRAESTRUTURA: sem template de negócio, sem mensagem específica.
// Define a ESTRUTURA padrão (código, nome, canal, versão, status, tipo,
// categoria) e o validador do contrato. Espelha s7_notification_templates.
// =============================================================================

import { isRegisteredChannel } from "../channels/channelRegistry.js";

/**
 * Ciclo de vida do template.
 * @type {const}
 */
export const S7_TEMPLATE_STATUS = Object.freeze({
  DRAFT: "draft",
  ACTIVE: "active",
  DEPRECATED: "deprecated",
  ARCHIVED: "archived",
});

const STATUS_SET = new Set(Object.values(S7_TEMPLATE_STATUS));

/** @param {string} status */
export function isValidTemplateStatus(status) {
  return STATUS_SET.has(String(status ?? "").trim().toLowerCase());
}

/**
 * Tipo genérico do template (sem regra de negócio).
 * @type {const}
 */
export const S7_TEMPLATE_TYPE = Object.freeze({
  TRANSACTIONAL: "transactional",
  OPERATIONAL: "operational",
  SYSTEM: "system",
});

const TYPE_SET = new Set(Object.values(S7_TEMPLATE_TYPE));

/** @param {string} type */
export function isValidTemplateType(type) {
  return TYPE_SET.has(String(type ?? "").trim().toLowerCase());
}

/** Versão inicial padrão de um template. */
export const S7_TEMPLATE_INITIAL_VERSION = 1;

/**
 * @typedef {Object} S7TemplateContract
 * @property {string} template_key   código único do template (ex.: "billing.payment.failed")
 * @property {string} name           rótulo legível
 * @property {string} channel        canal (deve existir no Registro de Canais)
 * @property {string} locale
 * @property {number} version
 * @property {string} status
 * @property {string|null} template_type
 * @property {string|null} category_code
 * @property {string|null} type_key
 * @property {string} subject_template
 * @property {string} body_template
 * @property {unknown[]} variables_schema
 */

/** @param {unknown} v */
function asStr(v) {
  return v == null ? "" : String(v).trim();
}

/**
 * Normaliza uma linha (s7_notification_templates) para o contrato canônico.
 * @param {Record<string, any>} row
 * @returns {S7TemplateContract}
 */
export function toTemplateContract(row = {}) {
  return {
    template_key: asStr(row.template_key),
    name: asStr(row.name) || asStr(row.template_key),
    channel: asStr(row.channel),
    locale: asStr(row.locale) || "pt-BR",
    version: Number.isInteger(row.version) ? row.version : S7_TEMPLATE_INITIAL_VERSION,
    status: asStr(row.status).toLowerCase() || S7_TEMPLATE_STATUS.ACTIVE,
    template_type: row.template_type != null ? asStr(row.template_type).toLowerCase() : null,
    category_code: row.category_code != null ? asStr(row.category_code) : null,
    type_key: row.type_key != null ? asStr(row.type_key) : null,
    subject_template: row.subject_template != null ? String(row.subject_template) : "",
    body_template: row.body_template != null ? String(row.body_template) : "",
    variables_schema: Array.isArray(row.variables_schema) ? row.variables_schema : [],
  };
}

/**
 * Valida o contrato de um template. Códigos de erro estáveis.
 * @param {Partial<S7TemplateContract>} contract
 * @returns {{ ok: boolean; errors: string[]; primaryError: string | null }}
 */
export function validateTemplateContract(contract) {
  /** @type {string[]} */
  const errors = [];
  const c = contract && typeof contract === "object" ? contract : {};

  if (!asStr(c.template_key)) errors.push("MISSING_TEMPLATE_KEY");
  if (!asStr(c.channel)) errors.push("MISSING_CHANNEL");
  else if (!isRegisteredChannel(asStr(c.channel))) errors.push("UNREGISTERED_CHANNEL");

  if (c.status != null && !isValidTemplateStatus(String(c.status))) errors.push("INVALID_STATUS");
  if (c.template_type != null && !isValidTemplateType(String(c.template_type))) errors.push("INVALID_TYPE");

  if (c.version != null && (!Number.isInteger(c.version) || c.version < 1)) errors.push("INVALID_VERSION");

  if (c.variables_schema != null && !Array.isArray(c.variables_schema)) errors.push("INVALID_VARIABLES_SCHEMA");

  return { ok: errors.length === 0, errors, primaryError: errors[0] ?? null };
}
