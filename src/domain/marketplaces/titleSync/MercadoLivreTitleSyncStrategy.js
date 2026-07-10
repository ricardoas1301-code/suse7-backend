// ======================================================================
// Mercado Livre — Strategy de sincronização de título do produto → anúncio
// Bloqueio: sold_quantity > 0 (regra oficial ML — anúncio com vendas).
// Campo usado: raw_json.sold_quantity (fallback soma variations[].sold_quantity).
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import { putMercadoLibreItemTitle } from "../../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { MLB_TITLE_MAX_LENGTH } from "./MarketplaceTitleSyncStrategy.js";

export const ML_TITLE_SOLD_BLOCK_REASON =
  "O Mercado Livre não permite alterar o título de anúncios que já possuem vendas.";

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numeroOuNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Record<string, unknown>} rawJson
 * @returns {{ quantity: number; source: string }}
 */
export function extrairSoldQuantityMercadoLivre(rawJson) {
  const fromItem = numeroOuNull(rawJson?.sold_quantity);
  if (fromItem != null) {
    return { quantity: Math.max(0, Math.trunc(fromItem)), source: "raw_json.sold_quantity" };
  }
  const vars = Array.isArray(rawJson?.variations) ? rawJson.variations : [];
  if (vars.length === 0) {
    return { quantity: 0, source: "raw_json.sold_quantity" };
  }
  let sum = 0;
  let hasAny = false;
  for (const raw of vars) {
    if (!raw || typeof raw !== "object") continue;
    const sq = numeroOuNull(/** @type {Record<string, unknown>} */ (raw).sold_quantity);
    if (sq != null) {
      sum += sq;
      hasAny = true;
    }
  }
  if (hasAny) {
    return { quantity: Math.max(0, Math.trunc(sum)), source: "raw_json.variations[].sold_quantity" };
  }
  return { quantity: 0, source: "raw_json.sold_quantity" };
}

/** @type {import("./MarketplaceTitleSyncStrategy.js").MarketplaceTitleSyncStrategy} */
export const MercadoLivreTitleSyncStrategy = {
  marketplaceSlug: ML_MARKETPLACE_SLUG,
  titleMaxLength: MLB_TITLE_MAX_LENGTH,

  canUpdateTitle(context) {
    const rawJson =
      context.rawJson && typeof context.rawJson === "object" && !Array.isArray(context.rawJson)
        ? context.rawJson
        : {};
    const { quantity, source } = extrairSoldQuantityMercadoLivre(rawJson);
    if (quantity > 0) {
      return {
        canUpdateTitle: false,
        reason: ML_TITLE_SOLD_BLOCK_REASON,
        soldQuantity: quantity,
        soldQuantitySource: source,
      };
    }
    return {
      canUpdateTitle: true,
      soldQuantity: quantity,
      soldQuantitySource: source,
    };
  },

  validateTitle(title) {
    const value = String(title ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (!value) {
      return { valid: false, reason: "Título não pode ser vazio." };
    }
    if (value.length > MLB_TITLE_MAX_LENGTH) {
      return {
        valid: false,
        reason: `Título excede o limite de ${MLB_TITLE_MAX_LENGTH} caracteres do Mercado Livre.`,
      };
    }
    return { valid: true };
  },

  async updateListingTitle(accessToken, context, title) {
    const itemId = String(context.externalListingId ?? "").trim();
    if (!itemId) {
      return { ok: false, status: "failed", errorMessage: "external_listing_id inválido." };
    }
    try {
      const rawItem = await putMercadoLibreItemTitle(accessToken, itemId, title);
      return { ok: true, status: "synced", rawItem };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, status: "failed", errorMessage: msg };
    }
  },
};
