// ======================================================

// REGRA ARQUITETURAL SUSE7

// ======================================================

// Dados de marketplace NUNCA devem ser exibidos diretamente da API externa no produto.

// Todo dado deve: (1) persistir no banco próprio; (2) ser tratado/calculado no backend;

// (3) só então ser exibido no frontend. Exceções só conscientes e raras.

// ======================================================

// Preço efetivo da venda — delega ao núcleo domain/pricing (única fonte de verdade).

// ======================================================



import { resolveMercadoLivreSalePriceOfficial } from "../../../../domain/pricing/mercadoLivreSalePriceOfficial.js";



/**

 * @typedef {{

 *   listing_price: number;

 *   promotion_price: number | null;

 *   has_active_promotion: boolean;

 * }} SalePriceEffectiveInput

 */



/**

 * Compatibilidade: retorna apenas o número efetivo.

 * Para auditoria completa (listing, promo, decision_source, etc.), use

 * `resolveMercadoLivreSalePriceOfficial` em `src/domain/pricing`.

 *

 * @param {SalePriceEffectiveInput} input

 * @returns {number}

 */

export function getSalePriceEffective(input) {

  const r = resolveMercadoLivreSalePriceOfficial({

    marketplace: "mercado_livre",

    listing_price: input.listing_price,

    promotion_price: input.promotion_price,

    has_active_promotion_hint: input.has_active_promotion,

    context: "getSalePriceEffective_compat",

  });

  if (r.sale_price_effective == null) {

    throw new Error("Invalid listing_price");

  }

  return Number(r.sale_price_effective);

}



export { resolveMercadoLivreSalePriceOfficial } from "../../../../domain/pricing/mercadoLivreSalePriceOfficial.js";


