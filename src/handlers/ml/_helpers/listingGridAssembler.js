// ======================================================
// Consolidação da grid de anúncios — multi-marketplace.
// Regras monetárias e joins ficam aqui; a rota só orquestra dados.
//
// Contrato GET /api/ml/listings — pricing (Suse7 Pricing Protocol v1):
// - Preço: `listing_sale_price_brl`, `promotion_sale_price_brl`, `listing_grid_price_evidence`,
//   `listing_price_brl` (legado), `promotion_active`, `promotional_price_brl`, `effective_sale_price_brl`
//   (ver docs/SUSE7_PRICING_PROTOCOL_V1.md).
// - Repasse “Você recebe”: `marketplace_payout_amount` + `marketplace_payout_source` (health/sync ML).
// - `price_brl`: espelho legado de `effective_sale_price_brl` — não usar como fonte principal.
// - `net_proceeds`: breakdown auxiliar; não é fonte do payout oficial.
// - `pricing_context`: Raio-x (backend).
// - `legacy_imported_orders_metrics`: agregados importados (não unitário).
// Versão incrementada quando o shape monetário quebra consumidores.
// Padrão de preços v13: `listing_sale_price_brl`, `promotion_sale_price_brl`, `listing_grid_price_evidence`.
// ======================================================

import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { normalizeExternalListingId } from "./mlSalesPersist.js";
import { buildMercadoLivreListingGridRow } from "./marketplaces/mercadoLivreListingGrid.js";

export { normalizeExternalListingId };

/** Incrementar ao mudar o contrato monetário exposto em GET /api/ml/listings. */
export const LISTING_GRID_MONEY_CONTRACT_VERSION = 13;

/** Chaves obrigatórias do contrato de pricing v1 em cada linha da grid (valores podem ser null). */
const LISTING_GRID_PRICING_V1_KEYS = /** @type {const} */ ([
  "listing_price_brl",
  "listing_sale_price_brl",
  "promotion_sale_price_brl",
  "listing_grid_price_evidence",
  "promotion_active",
  "promotional_price_brl",
  "effective_sale_price_brl",
  "marketplace_payout_amount",
  "marketplace_payout_source",
]);

/** Fallback se algum builder antigo ou serialização omitir net_proceeds (JSON dropa `undefined`). */
const GRID_NET_PROCEEDS_FALLBACK = {
  sale_price: null,
  original_price: null,
  sale_fee_amount: null,
  sale_fee_percent: null,
  shipping_cost_amount: null,
  net_proceeds_amount: null,
  marketplace_payout_amount: null,
  marketplace_payout_amount_brl: null,
  marketplace_payout_source: null,
  marketplace_cost_reduction_amount: null,
  marketplace_cost_reduction_amount_brl: null,
  marketplace_cost_reduction_source: null,
  marketplace_cost_reduction_label: null,
  currency: "BRL",
  is_estimated: false,
  source: /** @type {const} */ ("insufficient_data"),
  insufficient_reason:
    "Bloco net_proceeds ausente na montagem da grid. Confira deploy com listing_grid_contract_version >= 3 e código atual de mercadoLivreListingGrid.js.",
  has_valid_data: false,
};

/**
 * Garante chaves estáveis na resposta JSON (net_proceeds nunca omitido; pricing_context explícito).
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {Record<string, unknown>}
 */
export function ensureListingGridMoneyContract(row) {
  const r = row && typeof row === "object" && !Array.isArray(row) ? { ...row } : {};
  const np = r.net_proceeds;
  if (np == null || typeof np !== "object" || Array.isArray(np)) {
    r.net_proceeds = { ...GRID_NET_PROCEEDS_FALLBACK };
  }
  if (!Object.prototype.hasOwnProperty.call(r, "pricing_context")) {
    r.pricing_context = null;
  }
  for (const k of LISTING_GRID_PRICING_V1_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(r, k)) {
      if (k === "promotion_active") r[k] = false;
      else if (k === "listing_grid_price_evidence") r[k] = null;
      else r[k] = null;
    }
  }
  r.promotion_active = r.promotion_active === true;
  if (r.marketplace_payout_source == null || String(r.marketplace_payout_source).trim() === "") {
    r.marketplace_payout_source = "unresolved";
  }
  return r;
}

/**
 * @param {string} marketplace
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | undefined} metrics
 * @param {Record<string, unknown> | undefined} health
 * @param {string | null} cover_thumbnail_url
 * @param {{ sellerTaxPct?: string | number | null }} [opts]
 */
export function buildListingGridRow(marketplace, listing, metrics, health, cover_thumbnail_url, opts = {}) {
  const m = String(marketplace || "");
  if (m === ML_MARKETPLACE_SLUG) {
    return buildMercadoLivreListingGridRow({
      listing,
      metrics: metrics ?? null,
      health: health ?? null,
      cover_thumbnail_url: cover_thumbnail_url ?? null,
      sellerTaxPct: opts.sellerTaxPct ?? null,
    });
  }
  return buildMercadoLivreListingGridRow({
    listing,
    metrics: metrics ?? null,
    health: health ?? null,
    cover_thumbnail_url: cover_thumbnail_url ?? null,
    sellerTaxPct: opts.sellerTaxPct ?? null,
  });
}
