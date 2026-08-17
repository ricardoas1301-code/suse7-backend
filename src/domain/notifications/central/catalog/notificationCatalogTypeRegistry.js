// =============================================================================
// S7 — Catálogo (S5.11) — esqueleto de tipos de evento (sem cadastro novo)
// =============================================================================

import { S7_NOTIFICATION_TYPE_CATALOG } from "../constants/eventTypes.js";
import { S7_NOTIFICATION_CATALOG_DOMAIN_GROUP } from "./notificationCatalogContract.js";

/**
 * Grupos de tipos suportados (estrutura — instâncias futuras).
 */
export const S7_CATALOG_EVENT_TYPE_GROUPS = Object.freeze(
  Object.values(S7_NOTIFICATION_CATALOG_DOMAIN_GROUP).map((group) => ({
    group_code: group,
    description: `Grupo de domínio ${group} — futuras notificações`,
  }))
);

/**
 * Formato canônico de definição futura (não persistido nesta fase).
 * @typedef {Object} S7FutureNotificationDefinition
 * @property {string} code
 * @property {string} name
 * @property {string} category_code
 * @property {string} type_key
 * @property {string} priority
 * @property {string} mandatory_tier
 * @property {string[]} allowed_channels
 * @property {string | null} template_key
 * @property {string | null} origin_module
 * @property {Record<string, unknown> | null} dispatch_rules_ref
 */

/**
 * @param {Partial<S7FutureNotificationDefinition>} def
 */
export function validateFutureNotificationDefinitionShape(def = {}) {
  const errors = [];
  if (!def.code || String(def.code).trim() === "") errors.push("code_required");
  if (!def.category_code) errors.push("category_code_required");
  if (!def.type_key) errors.push("type_key_required");
  return { ok: errors.length === 0, errors };
}

/**
 * Contagem de entradas no espelho runtime Phase 3.1 (leitura — não cadastro S5.11).
 */
export function countRuntimeCatalogTypeEntries() {
  return Object.keys(S7_NOTIFICATION_TYPE_CATALOG).length;
}

/**
 * Lista chaves runtime existentes (category:type) — somente auditoria.
 */
export function listRuntimeCatalogTypeKeys() {
  return Object.keys(S7_NOTIFICATION_TYPE_CATALOG);
}
