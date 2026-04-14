// ======================================================
// DOMAIN — núcleo oficial de preço efetivo de venda (Mercado Livre)
// ======================================================
// REGRA: promoção válida ⇔ preço promocional > 0 e < listing_price (Decimal).
// Decisão data-driven; `has_active_promotion_hint` só gera log se conflitar com os dados.
// Saída em strings com 2 casas (ROUND_HALF_UP) para API/persist audit.
// Multi-marketplace: outros canais podem expor resolve* paralelo reutilizando guards/log.
// ======================================================

import Decimal from "decimal.js";
import {
  normalizeMoneyToDecimal,
  validatePromotionListingConsistency,
} from "./pricingGuards.js";
import {
  logPricingEvent,
  PRICING_EVENT_CODE,
  PRICING_LOG_LEVEL,
} from "./pricingInconsistencyLog.js";

/**
 * @typedef {Object} MercadoLivreSalePriceOfficialInput
 * @property {string} [marketplace] default mercado_livre
 * @property {string|null} [listing_id]
 * @property {string|null} [user_id]
 * @property {string|null} [marketplace_account_id]
 * @property {unknown} listing_price
 * @property {unknown} [promotion_price]
 * @property {boolean} [has_active_promotion_hint]
 * @property {string} [context]
 */

/**
 * @typedef {Object} MercadoLivreSalePriceOfficialResult
 * @property {string} marketplace
 * @property {string|null} listing_id
 * @property {string|null} user_id
 * @property {string|null} marketplace_account_id
 * @property {string|null} listing_price
 * @property {string|null} promotion_price — só preenchido se promoção válida (UI Raio-x)
 * @property {string|null} promotion_price_observed — valor bruto da fonte, mesmo se inválido
 * @property {string|null} sale_price_effective
 * @property {boolean} has_valid_promotion
 * @property {string} decision_source
 * @property {string[]} inconsistency_codes
 */

const ROUND = Decimal.ROUND_HALF_UP;

/**
 * Fonte única de verdade para sale_price_effective no backend Suse7 (ML).
 *
 * @param {MercadoLivreSalePriceOfficialInput} ctx
 * @returns {MercadoLivreSalePriceOfficialResult}
 */
export function resolveMercadoLivreSalePriceOfficial(ctx) {
  const marketplace = ctx.marketplace ?? "mercado_livre";
  const listing_id = ctx.listing_id != null ? String(ctx.listing_id) : null;
  const user_id = ctx.user_id != null ? String(ctx.user_id) : null;
  const marketplace_account_id =
    ctx.marketplace_account_id != null ? String(ctx.marketplace_account_id) : null;
  const logContext = ctx.context ?? "resolve_mercado_livre_sale_price";

  /** @returns {Record<string, unknown>} */
  const baseLog = () => ({
    marketplace,
    listing_id,
    user_id,
    marketplace_account_id,
    context: logContext,
  });

  const listDec = normalizeMoneyToDecimal(ctx.listing_price);
  const rawPromoDec = normalizeMoneyToDecimal(ctx.promotion_price);

  if (listDec == null) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.INVALID_LISTING_PRICE, {
      ...baseLog(),
      listing_price_raw: ctx.listing_price ?? null,
      message: "listing_price ausente, zero ou inválido — sale_price_effective não calculado",
    });
    return {
      marketplace,
      listing_id,
      user_id,
      marketplace_account_id,
      listing_price: null,
      promotion_price:
        rawPromoDec != null ? rawPromoDec.toDecimalPlaces(2, ROUND).toFixed(2) : null,
      sale_price_effective: null,
      has_valid_promotion: false,
      decision_source: "invalid_listing_price",
      inconsistency_codes: [PRICING_EVENT_CODE.INVALID_LISTING_PRICE],
    };
  }

  const listStr = listDec.toDecimalPlaces(2, ROUND).toFixed(2);
  const promoStrRaw =
    rawPromoDec != null ? rawPromoDec.toDecimalPlaces(2, ROUND).toFixed(2) : null;

  for (const iss of validatePromotionListingConsistency(listDec, rawPromoDec)) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, iss.code, {
      ...baseLog(),
      listing_price: listStr,
      promotion_price: promoStrRaw,
      message: iss.message,
    });
  }

  const has_valid_promotion =
    rawPromoDec != null && rawPromoDec.gt(0) && rawPromoDec.lt(listDec);
  const effectiveDec = has_valid_promotion ? rawPromoDec : listDec;
  /** @type {string[]} */
  const inconsistency_codes = [];

  if (ctx.has_active_promotion_hint === true && !has_valid_promotion) {
    inconsistency_codes.push(PRICING_EVENT_CODE.PROMOTION_HINT_MISMATCH);
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.INVALID_PROMOTION_DATA, {
      ...baseLog(),
      listing_price: listStr,
      promotion_price: promoStrRaw,
      message:
        "Indicador de promoção ativa mas preço promocional não sustenta — usa listing (regra oficial)",
    });
  }

  if (ctx.has_active_promotion_hint === false && has_valid_promotion) {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.PROMOTION_DATA_OVERRIDES_HINT, {
      ...baseLog(),
      listing_price: listStr,
      promotion_price: promoStrRaw,
      sale_price_effective: effectiveDec.toDecimalPlaces(2, ROUND).toFixed(2),
      message:
        "Promoção válida inferida dos preços apesar de hint false — política data-driven Suse7",
    });
  }

  const decision_source = has_valid_promotion ? "promotion_valid_lt_listing" : "listing_price_only";

  return {
    marketplace,
    listing_id,
    user_id,
    marketplace_account_id,
    listing_price: listStr,
    /** Somente quando promoção é válida (modal Raio-x / repasse). */
    promotion_price: has_valid_promotion ? promoStrRaw : null,
    /** Valor promocional observado na fonte, mesmo quando inválido (auditoria). */
    promotion_price_observed: promoStrRaw,
    sale_price_effective: effectiveDec.toDecimalPlaces(2, ROUND).toFixed(2),
    has_valid_promotion,
    decision_source,
    inconsistency_codes,
  };
}
