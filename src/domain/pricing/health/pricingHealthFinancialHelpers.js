// ======================================================================
// Snapshot financeiro por anúncio — Central de Saúde da Precificação.
// SSOT: buildMercadoLivrePricingContext + marketplace_listing_health cache.
// Sem API externa; Decimal no domínio de precificação.
// ======================================================================

import Decimal from "decimal.js";
import { buildMercadoLivrePricingContext } from "../../../handlers/ml/_helpers/marketplaces/mercadoLivreRaioxPricing.js";
import { toDecimalOrNull } from "../../products/health/productHealthNumericHelpers.js";

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} productCosts
 */
function mesclarListingComProduto(listing, productCosts) {
  const pc = productCosts && typeof productCosts === "object" ? productCosts : {};
  return {
    ...listing,
    product_name: pc.product_name ?? listing.product_name ?? listing.title ?? null,
    product_sku: pc.sku ?? listing.product_sku ?? listing.seller_sku ?? null,
  };
}

/**
 * @param {{
 *   listing: Record<string, unknown>;
 *   health: Record<string, unknown> | null | undefined;
 *   productCosts: Record<string, unknown> | null | undefined;
 *   sellerTaxPct: string | null | undefined;
 * }} input
 * @returns {Record<string, unknown>}
 */
export function montarSnapshotPrecificacaoAnuncio(input) {
  const { listing, health, productCosts, sellerTaxPct } = input;
  const listingId = listing?.id != null ? String(listing.id).trim() : "";
  const listingMesclado = mesclarListingComProduto(listing, productCosts);

  const ctx = buildMercadoLivrePricingContext({
    listing: listingMesclado,
    health,
    netProceeds: null,
    productCosts,
    sellerTaxPct,
  });

  const productHealth =
    ctx.product_health != null && typeof ctx.product_health === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.product_health)
      : {};
  const result =
    ctx.result != null && typeof ctx.result === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.result)
      : null;
  const ui =
    ctx.ui != null && typeof ctx.ui === "object" ? /** @type {Record<string, unknown>} */ (ctx.ui) : {};

  const marginPctStr = result?.margin_pct != null ? String(result.margin_pct) : null;
  const marginPct = toDecimalOrNull(marginPctStr);
  const profitBrl = toDecimalOrNull(result?.profit_brl);
  const hasResult = result != null && ui.block3_mode === "ok";

  return {
    marketplace_listing_id: listingId,
    external_listing_id: listing.external_listing_id ?? null,
    marketplace: listing.marketplace ?? null,
    product_health_status: productHealth.product_health_status ?? null,
    has_product_link: productHealth.has_product_link === true,
    has_complete_costs: productHealth.has_complete_costs === true,
    offer_status_semantic: result?.offer_status_semantic ?? null,
    offer_status_key: result?.offer_status_key ?? null,
    margin_pct: marginPctStr,
    margin_pct_decimal: marginPct,
    profit_brl_decimal: profitBrl,
    has_result: hasResult,
    ui_block3_mode: ui.block3_mode ?? null,
    ui_block2_mode: ui.block2_mode ?? null,
  };
}

/**
 * @param {Decimal | null | undefined} marginPct
 * @returns {boolean}
 */
export function margemProjetadaCalculavel(marginPct) {
  return marginPct != null && marginPct.isFinite();
}
