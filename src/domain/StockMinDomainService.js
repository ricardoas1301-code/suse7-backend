// ======================================================================
// SUSE7 — Stock Min Domain Service
// Regras para estoque mínimo e notificações STOCK_LOW (incidente abre/fecha)
// ======================================================================

/**
 * Retorna o scopeId para identificação única do item.
 * @param {{ id?: string; productId?: string; variantId?: string; variantKey?: string }} item
 * @returns {string} ex: "product:<id>" ou "variant:<id>" ou "variant_key:<key>"
 */
export function getStockScope(item) {
  if (!item) return "unknown";

  if (item.variantId) {
    return `variant:${item.variantId}`;
  }
  if (item.variantKey) {
    return `variant_key:${item.variantKey}`;
  }
  const productId = item.productId ?? item.id;
  if (productId) {
    return `product:${productId}`;
  }

  return "unknown";
}

/**
 * Constrói chave de deduplicação para notificação.
 * Uma única notificação ativa por (user_id, dedupe_key).
 * @param {{ type: string; productId: string; variantId?: string; variantKey?: string }} params
 * @returns {string} ex: "STOCK_LOW:product=<id>:variant=<id|key|none>"
 */
export function buildDedupeKey({ type, productId, variantId, variantKey }) {
  const variantPart = variantId ?? variantKey ?? "none";
  return `${type}:product=${productId}:variant=${variantPart}`;
}

/**
 * Deve abrir incidente (criar notificação)?
 * @param {number} currentStock - estoque atual
 * @param {number} minStock - estoque mínimo
 * @returns {boolean}
 */
export function shouldOpenIncident(currentStock, minStock) {
  if (minStock == null || minStock === "") return false;
  const min = parseInt(String(minStock), 10);
  if (Number.isNaN(min) || min < 0) return false;
  const curr = parseInt(String(currentStock), 10);
  if (Number.isNaN(curr) || curr < 0) return false;
  return curr <= min;
}

/**
 * Deve resolver incidente (marcar resolved_at)?
 * @param {number} currentStock - estoque atual
 * @param {number} minStock - estoque mínimo
 * @returns {boolean}
 */
export function shouldResolveIncident(currentStock, minStock) {
  if (minStock == null || minStock === "") return false;
  const min = parseInt(String(minStock), 10);
  if (Number.isNaN(min) || min < 0) return false;
  const curr = parseInt(String(currentStock), 10);
  if (Number.isNaN(curr) || curr < 0) return false;
  return curr > min;
}
