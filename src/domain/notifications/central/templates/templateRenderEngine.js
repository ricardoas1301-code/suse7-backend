// =============================================================================
// S7 — Central de Templates (Fase S5.4)
// Engine de renderização: recebe template + variáveis → resolve placeholders
// → gera conteúdo final. Constrói sobre o render legado ({{var}}) sem quebrá-lo.
//
// Camada de INFRAESTRUTURA: sem templates reais, sem regra de negócio.
// =============================================================================

import { renderNotificationTemplate } from "./renderNotificationTemplate.js";

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Extrai os nomes de placeholders ({{var}}) de uma string de template.
 * @param {string} template
 * @returns {string[]} nomes únicos, na ordem de aparição
 */
export function extractTemplatePlaceholders(template) {
  const out = [];
  const seen = new Set();
  const src = String(template ?? "");
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(src)) !== null) {
    const key = m[1];
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Renderiza UMA string resolvendo placeholders. Reusa o render legado.
 * @param {string} template
 * @param {Record<string, unknown>} variables
 * @returns {string}
 */
export function renderTemplateString(template, variables) {
  return renderNotificationTemplate(String(template ?? ""), variables ?? {});
}

/**
 * Calcula placeholders sem valor (variáveis ausentes/nulas) num conjunto.
 * @param {string[]} placeholders
 * @param {Record<string, unknown>} variables
 * @returns {string[]}
 */
function findMissing(placeholders, variables) {
  const vars = variables ?? {};
  return placeholders.filter((key) => vars[key] == null || vars[key] === "");
}

/**
 * Renderiza um template completo (subject + body) com diagnóstico.
 *
 * @param {{ subject_template?: string; body_template?: string }} template
 * @param {Record<string, unknown>} variables
 * @returns {{
 *   subject: string;
 *   body: string;
 *   placeholders: string[];
 *   missing_variables: string[];
 *   ok: boolean;
 * }}
 */
export function renderTemplate(template, variables) {
  const subjectTpl = String(template?.subject_template ?? "");
  const bodyTpl = String(template?.body_template ?? "");
  const vars = variables ?? {};

  const placeholders = Array.from(
    new Set([...extractTemplatePlaceholders(subjectTpl), ...extractTemplatePlaceholders(bodyTpl)])
  );
  const missing = findMissing(placeholders, vars);

  return {
    subject: renderTemplateString(subjectTpl, vars),
    body: renderTemplateString(bodyTpl, vars),
    placeholders,
    missing_variables: missing,
    ok: missing.length === 0,
  };
}
