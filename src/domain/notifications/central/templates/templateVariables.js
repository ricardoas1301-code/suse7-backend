// =============================================================================
// S7 — Central de Templates (Fase S5.4)
// Variáveis dinâmicas — infraestrutura de escopos (global / canal / contexto).
//
// Camada de INFRAESTRUTURA: NÃO define variáveis de negócio. Apenas o mecanismo
// de declaração, mesclagem por escopo e resolução do contexto final de
// variáveis que a engine de renderização consome.
//
// Precedência (maior vence): contexto > canal > global.
// Ex.: {{seller_name}}, {{order_id}}, {{marketplace_name}} serão registrados
// em fases futuras — aqui só a estrutura.
// =============================================================================

/**
 * Escopos oficiais de variáveis.
 * @type {const}
 */
export const S7_TEMPLATE_VARIABLE_SCOPE = Object.freeze({
  GLOBAL: "global", // disponíveis para qualquer canal/contexto
  CHANNEL: "channel", // específicas de um canal
  CONTEXT: "context", // específicas do evento/contexto em runtime
});

/**
 * @typedef {Object} S7TemplateVariableDescriptor
 * @property {string} key            ex.: "seller_name"
 * @property {string} scope          global | channel | context
 * @property {string} [label]
 * @property {string} [example]
 * @property {boolean} [required]
 */

/** @param {Partial<S7TemplateVariableDescriptor>} d @returns {S7TemplateVariableDescriptor} */
export function defineTemplateVariable(d = {}) {
  return {
    key: String(d.key ?? "").trim(),
    scope: String(d.scope ?? S7_TEMPLATE_VARIABLE_SCOPE.CONTEXT).trim().toLowerCase(),
    label: d.label != null ? String(d.label) : undefined,
    example: d.example != null ? String(d.example) : undefined,
    required: d.required === true,
  };
}

/** @param {unknown} obj @returns {Record<string, unknown>} */
function asObject(obj) {
  return obj && typeof obj === "object" && !Array.isArray(obj)
    ? /** @type {Record<string, unknown>} */ (obj)
    : {};
}

/**
 * Resolve o contexto final de variáveis a partir dos escopos.
 * Precedência: context > channel > global.
 *
 * @param {{
 *   global?: Record<string, unknown>;
 *   channel?: Record<string, unknown>;
 *   context?: Record<string, unknown>;
 * }} scopes
 * @returns {Record<string, unknown>}
 */
export function buildTemplateVariableContext(scopes = {}) {
  return {
    ...asObject(scopes.global),
    ...asObject(scopes.channel),
    ...asObject(scopes.context),
  };
}

/**
 * Constrói um conjunto de exemplo (simulação) a partir de descritores.
 * Útil para preview sem dados reais.
 * @param {S7TemplateVariableDescriptor[]} descriptors
 * @returns {Record<string, string>}
 */
export function buildSampleVariables(descriptors) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const d of Array.isArray(descriptors) ? descriptors : []) {
    if (!d?.key) continue;
    out[d.key] = d.example != null ? String(d.example) : `{{${d.key}}}`;
  }
  return out;
}

/**
 * Normaliza o `variables_schema` (jsonb) de um template para descritores.
 * Aceita array de strings ("seller_name") ou de objetos ({key, scope, ...}).
 * @param {unknown} schema
 * @returns {S7TemplateVariableDescriptor[]}
 */
export function normalizeVariablesSchema(schema) {
  if (!Array.isArray(schema)) return [];
  return schema
    .map((item) => {
      if (typeof item === "string") return defineTemplateVariable({ key: item, scope: S7_TEMPLATE_VARIABLE_SCOPE.CONTEXT });
      if (item && typeof item === "object") return defineTemplateVariable(/** @type {object} */ (item));
      return null;
    })
    .filter((d) => d != null && d.key !== "");
}
