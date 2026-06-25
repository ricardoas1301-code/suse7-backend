// ======================================================
// Fonte única de verdade — simulação financeira de precificação (multi-marketplace).
// Hoje: MercadoLivrePricingSimulator. Futuro: Shopee, Amazon, Shein.
// Todos os valores monetários saem como string decimal (2 casas). Sem float.
// ======================================================

import Decimal from "decimal.js";

import {
  aplicarExtrasPrecificacaoInteligente,
  parseExtrasPrecificacaoInteligenteFromBody,
} from "./aplicarExtrasPrecificacaoInteligente.js";
import { simulateMercadoLivreListingTypeScenario } from "./mercadoLivreSimulateListingTypeScenario.js";

const ROUND = Decimal.ROUND_HALF_UP;

/** @typedef {"classic" | "premium"} ListingTypeChoice */

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str2(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d.toDecimalPlaces(2, ROUND).toFixed(2) : null;
  } catch {
    return null;
  }
}

/**
 * Mapeia o cenário completo (computeOneScenario) para o contrato plano da PI/Raio-X.
 * @param {Record<string, unknown>} scenario
 * @param {{
 *   listing_external_id?: string | null;
 *   listing_type?: string | null;
 *   commission_source?: string | null;
 *   official_fee_percent?: string | null;
 * }} meta
 */
export function mapMercadoLivreScenarioToFlatFinancialContract(scenario, meta = {}) {
  const m =
    scenario.marketplace != null && typeof scenario.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.marketplace)
      : {};
  const ic =
    scenario.internal_costs != null && typeof scenario.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.internal_costs)
      : {};
  const res =
    scenario.result != null && typeof scenario.result === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.result)
      : {};
  const dq =
    scenario.data_quality != null && typeof scenario.data_quality === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.data_quality)
      : {};

  const salePrice = str2(m.sale_price_brl ?? scenario.sale_price_brl);
  const fee = str2(m.sale_fee_amount_brl ?? m.fee_amount_brl ?? scenario.fee_amount_brl);
  const shipping = str2(m.shipping_cost_amount_brl ?? scenario.shipping_cost_brl);
  const payout = str2(m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? scenario.net_receivable_brl);

  /** @type {string[]} */
  const warnings = [];
  if (Array.isArray(dq.warnings)) {
    for (const w of dq.warnings) {
      if (w != null && String(w).trim() !== "") warnings.push(String(w).trim());
    }
  }
  if (m.is_shipping_estimated === true) {
    warnings.push("Frete estimado — fonte oficial indisponível para este preço.");
  }

  const shippingSource = m.shipping_cost_source != null ? String(m.shipping_cost_source) : "unresolved";
  const isFallback =
    shippingSource === "unresolved" ||
    shippingSource.includes("simulation") ||
    shippingSource === "health_column" ||
    m.is_shipping_estimated === true;

  const piExtras =
    scenario.pricing_intelligence_extras != null && typeof scenario.pricing_intelligence_extras === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.pricing_intelligence_extras)
      : {};

  return {
    listing_external_id: meta.listing_external_id ?? null,
    listing_type: meta.listing_type ?? null,
    sale_price_brl: salePrice,
    official_fee_brl: fee,
    official_fee_percent:
      meta.official_fee_percent != null
        ? str2(meta.official_fee_percent)
        : str2(m.sale_fee_percent),
    commission_source: meta.commission_source ?? null,
    shipping_cost_brl: shipping,
    shipping_source: shippingSource,
    shipping_is_estimated: m.is_shipping_estimated === true,
    shipping_is_fallback: isFallback,
    payout_brl: payout,
    product_cost_brl: str2(ic.product_cost_brl),
    tax_brl: str2(ic.tax_amount_brl),
    tax_percent: str2(ic.tax_percent_applied),
    operation_cost_brl: str2(ic.operational_packaging_total_brl),
    packaging_operation_cost_brl: str2(ic.operational_packaging_total_brl),
    promotion_reserve_percent: str2(piExtras.promotion_reserve_percent),
    promotion_reserve_brl: str2(piExtras.promotion_reserve_brl),
    affiliate_percent: str2(piExtras.affiliate_percent),
    affiliate_brl: str2(piExtras.affiliate_brl),
    ads_percent: str2(piExtras.ads_percent),
    ads_brl: str2(piExtras.ads_brl),
    operational_cost_percent: str2(piExtras.operational_cost_percent),
    operational_cost_brl: str2(piExtras.operational_cost_brl),
    extras_total_brl: str2(piExtras.extras_total_brl),
    profit_brl: str2(res.profit_brl),
    margin_percent: str2(res.margin_pct),
    health_status:
      res.health_status != null
        ? String(res.health_status)
        : res.offer_status != null
          ? String(res.offer_status)
          : null,
    data_quality_source: dq.source != null ? String(dq.source) : null,
    warnings,
    scenario,
  };
}

/**
 * Simulador Mercado Livre — delega para a engine homologada (computeOneScenario).
 */
export const MercadoLivrePricingSimulator = {
  /**
   * @param {import("@supabase/supabase-js").SupabaseClient} supabase
   * @param {string} userId
   * @param {{
   *   listingExternalId?: string;
   *   listingId?: string;
   *   listingType: ListingTypeChoice;
   *   salePrice?: string | number | null;
   *   targetMarginPct?: string | number | null;
   *   mlAccessToken?: string | null;
   *   referenceZipCode?: string | null;
   *   financialExtras?: import("./aplicarExtrasPrecificacaoInteligente.js").ExtrasPrecificacaoInteligenteInput | null;
   * }} opts
   */
  async simulate(supabase, userId, opts) {
    const extras =
      opts.financialExtras != null
        ? opts.financialExtras
        : parseExtrasPrecificacaoInteligenteFromBody(/** @type {Record<string, unknown>} */ (opts));

    const result = await simulateMercadoLivreListingTypeScenario(supabase, userId, {
      ...opts,
      financialExtras: extras,
    });
    if (!result.ok || !result.data?.scenario) return result;

    const data = /** @type {Record<string, unknown>} */ (result.data);
    let scenario = /** @type {Record<string, unknown>} */ (data.scenario);

    scenario = aplicarExtrasPrecificacaoInteligente(scenario, extras);

    const financial = mapMercadoLivreScenarioToFlatFinancialContract(scenario, {
      listing_external_id: data.external_listing_id != null ? String(data.external_listing_id) : null,
      listing_type: data.listing_type != null ? String(data.listing_type) : null,
      commission_source: data.commission_source != null ? String(data.commission_source) : null,
      official_fee_percent: data.official_fee_percent != null ? String(data.official_fee_percent) : null,
    });

    console.info("[pricing-simulate] resolved", {
      listing_external_id: financial.listing_external_id,
      listing_type: financial.listing_type,
      sale_price_brl: financial.sale_price_brl,
      official_fee_brl: financial.official_fee_brl,
      shipping_cost_brl: financial.shipping_cost_brl,
      shipping_source: financial.shipping_source,
      shipping_is_fallback: financial.shipping_is_fallback,
      payout_brl: financial.payout_brl,
      promotion_reserve_brl: financial.promotion_reserve_brl,
      affiliate_brl: financial.affiliate_brl,
      ads_brl: financial.ads_brl,
      operational_cost_brl: financial.operational_cost_brl,
      profit_brl: financial.profit_brl,
      margin_percent: financial.margin_percent,
    });

    console.info("[pricing-chart-sync] financial_contract", {
      listing_external_id: financial.listing_external_id,
      listing_type: financial.listing_type,
      profit_brl: financial.profit_brl,
      margin_percent: financial.margin_percent,
      payout_brl: financial.payout_brl,
      extras_total_brl: financial.extras_total_brl,
    });

    return {
      ok: true,
      data: {
        ...data,
        scenario,
        financial,
        resolved_sale_price_brl: financial.sale_price_brl,
        resolved_margin_pct: financial.margin_percent,
      },
    };
  },
};

/**
 * Roteador multi-marketplace (Strategy Pattern).
 * @param {string} marketplace
 */
export function resolveMarketplacePricingSimulator(marketplace) {
  const m = String(marketplace ?? "").trim().toLowerCase();
  if (m === "mercado_livre" || m === "mercadolivre" || m === "ml") {
    return MercadoLivrePricingSimulator;
  }
  return null;
}
