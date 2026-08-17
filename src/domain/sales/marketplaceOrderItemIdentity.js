// ======================================================================
// Contrato modular de identidade de linha de pedido por marketplace.
// ======================================================================

import { resolveMercadoLivreOrderItemIdentity } from "./mercadoLivreOrderItemIdentity.js";

export {
  resolveMercadoLivreOrderItemIdentity,
  buildMercadoLivreOrderItemOccurrenceKey,
} from "./mercadoLivreOrderItemIdentity.js";

/**
 * @typedef {{
 *   external_order_item_id: string;
 *   identity_source: "official_line_id" | "synthetic";
 * }} MarketplaceOrderItemIdentity
 */

/**
 * @param {string} marketplace
 * @param {Record<string, unknown>} line
 * @param {{
 *   externalOrderId: string;
 *   lineIndex: number;
 *   linesInOrder: Record<string, unknown>[];
 * }} context
 * @returns {MarketplaceOrderItemIdentity}
 */
export function resolveMarketplaceOrderItemIdentity(marketplace, line, context) {
  const mkt = marketplace != null ? String(marketplace).trim().toLowerCase() : "";
  if (mkt === "mercado_livre" || mkt === "mercadolivre" || mkt === "ml") {
    return resolveMercadoLivreOrderItemIdentity(line, context);
  }
  throw new Error(`MarketplaceOrderItemIdentityStrategy ausente para: ${marketplace}`);
}
