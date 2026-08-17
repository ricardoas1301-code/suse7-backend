// =============================================================================
// Renderização {{var}} — templates centralizados
// =============================================================================

/**
 * @param {string} template
 * @param {Record<string, unknown>} variables
 */
export function renderNotificationTemplate(template, variables) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}
