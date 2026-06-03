// =============================================================================
// S7 — Central de Templates (Fase S5.4) — superfície pública
// =============================================================================

// Render legado (preservado) + engine formalizada
export { renderNotificationTemplate } from "./renderNotificationTemplate.js";
export { resolveNotificationTemplate } from "./resolveNotificationTemplate.js";
export {
  extractTemplatePlaceholders,
  renderTemplateString,
  renderTemplate,
} from "./templateRenderEngine.js";

// Contrato + status/tipo
export {
  S7_TEMPLATE_STATUS,
  S7_TEMPLATE_TYPE,
  S7_TEMPLATE_INITIAL_VERSION,
  isValidTemplateStatus,
  isValidTemplateType,
  toTemplateContract,
  validateTemplateContract,
} from "./templateContract.js";

// Variáveis dinâmicas
export {
  S7_TEMPLATE_VARIABLE_SCOPE,
  defineTemplateVariable,
  buildTemplateVariableContext,
  buildSampleVariables,
  normalizeVariablesSchema,
} from "./templateVariables.js";

// Registry único (acesso/consulta)
export {
  listTemplates,
  getTemplate,
  getTemplateVersionHistory,
  groupTemplatesByChannel,
  isTemplateChannelRegistered,
} from "./templateRegistry.js";

// Preview
export { previewTemplate } from "./templatePreview.js";
