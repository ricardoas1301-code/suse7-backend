// ======================================================
// REGRA ARQUITETURAL SUSE7
// ======================================================
// Dados de marketplace NUNCA devem ser exibidos diretamente da API externa no produto.
// Todo dado deve: (1) persistir no banco próprio; (2) ser tratado/calculado no backend;
// (3) só então ser exibido no frontend. Exceções só conscientes e raras.
// ======================================================
// Repasse líquido UNITÁRIO por venda — Mercado Livre.
// Base obrigatória: sale_price_effective — `resolveMercadoLivreSalePriceOfficial` (domain/pricing).
// Preferência: marketplace_listing_health + listing_prices (taxa oficial).
// Fallback: média real a partir de listing_sales_metrics (comissão e frete / qty vendida importada)
// quando não há taxa ML persistida nem derivável do item.
// Precisão: Decimal.js; saída serializada com 2 casas (string).
//
// Futuro: interface por marketplace (ex.: computeNetProceedsUnit(marketplace, listing, health)).
// ======================================================

import Decimal from "decimal.js";
import { resolveMercadoLivreSalePriceOfficial } from "../../../../domain/pricing/mercadoLivreSalePriceOfficial.js";
import {
  mercadoLivreShippingCostOfficialToPersistBlob,
  mercadoLivreShippingOfficialToNetProceedsFields,
  ML_SHIPPING_COST_OFFICIAL_LABEL,
  resolveMercadoLivreShippingCostOfficial,
} from "../../../../domain/pricing/mercadoLivreShippingCostOfficial.js";
import {
  logPricingEvent,
  PRICING_EVENT_CODE,
  PRICING_LOG_LEVEL,
} from "../../../../domain/pricing/pricingInconsistencyLog.js";
import {
  coalesceListingPricesPersistedFeeAmount,
  coalesceMercadoLibreItemForMoneyExtract,
  extractMercadoLivreLogisticsSellerCost,
  extractMercadoLivreMarketplaceCostReductionFromListingPricesRow,
  extractMercadoLivreOfficialShippingFromListingPricesRow,
  extractNetReceivableExplicit,
  extractPromotionPrice,
  extractSaleFee,
  extractShippingCost,
  mlFeeFinalDecisionLogEnabled,
} from "../mlItemMoneyExtract.js";
import { mlFeeValidateLogsEnabled } from "../mercadoLibreItemsApi.js";
import {
  mercadoLivreListingPayloadForMoneyFields,
  mercadoLivreListingPricesRowSaleFeeDetails,
  mercadoLivreMoneyShapeDiagnostics,
  mercadoLivrePickListingPriceCandidate,
  mercadoLivreToFiniteGrid,
} from "../mercadoLivreListingMoneyShared.js";
import { buildMercadoLivreFeeBreakdown } from "../finance/mercadoLivreFeeBreakdown.js";
import { formatMercadoLivreSaleFeeLabel } from "../finance/mercadoLivreListingTypeLabel.js";

/**
 * @typedef {"marketplace_api" | "calculated" | "insufficient_data" | "marketplace_listing_health" | "orders_fallback"} NetProceedsSource
 */

/**
 * @typedef {{
 *   sale_price: string | null;
 *   original_price: string | null;
 *   sale_price_effective: string | null;
 *   sale_fee_amount: string | null;
 *   sale_fee_percent: string | null;
 *   sale_fee_label: string | null;
 *   gross_fee_amount: string | null;
 *   marketplace_fee_discount_amount: string | null;
 *   sale_fee_amount_api: string | null;
 *   sale_fee_validation_status: string | null;
 *   sale_fee_difference_amount: string | null;
 *   marketplace_fee_source: string | null;
 *   calculation_confidence: string | null;
 *   shipping_cost_amount: string | null;
 *   shipping_cost_amount_brl?: string | null;
 *   shipping_cost_currency?: string | null;
 *   shipping_cost_source?: string | null;
 *   shipping_cost_context?: "free_for_buyer" | "buyer_pays" | null;
 *   shipping_cost_label?: string | null;
 *   shipping_cost_marketplace: string | null;
 *   fixed_fee_amount: string | null;
 *   suse7_shipping_cost?: Record<string, unknown> | null;
 *   ml_shipping_cost_label?: string | null;
 *   ml_shipping_cost_context?: "free_for_buyer" | "buyer_pays" | null;
 *   ml_shipping_cost_amount_brl?: string | null;
 *   ml_shipping_cost_source?: string | null;
 *   marketplace_payout: string | null;
 *   marketplace_payout_amount?: string | null;
 *   marketplace_payout_amount_brl?: string | null;
 *   marketplace_payout_source?: string | null;
 *   marketplace_cost_reduction_amount?: string | null;
 *   marketplace_cost_reduction_amount_brl?: string | null;
 *   marketplace_cost_reduction_source?: string | null;
 *   marketplace_cost_reduction_label?: string | null;
 *   net_proceeds_amount: string | null;
 *   currency: string;
 *   is_estimated: boolean;
 *   source: NetProceedsSource;
 *   insufficient_reason: string | null;
 *   has_valid_data: boolean;
 * }} ListingNetProceedsPayload
 */

const CURRENCY = "BRL";
const EPS_MATCH = new Decimal("0.05");

/** @param {Record<string, unknown>} listing */
function mlNetProceedsShouldDebug(listing) {
  if (process.env.ML_NET_PROCEEDS_DEBUG === "1") return true;
  const id = String(listing?.external_listing_id ?? listing?.id ?? "");
  const needle = String(process.env.ML_NET_PROCEEDS_DEBUG_EXT_ID ?? "4473596489").trim();
  return needle !== "" && id.includes(needle);
}

/** @param {unknown} v @returns {Decimal | null} */
function dMoney(v) {
  if (v == null || v === "") return null;
  try {
    const x = new Decimal(String(v));
    return x.isFinite() ? x : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d @returns {string | null} */
function decToApiStr(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Fonte oficial única de payout líquido (multi-uso backend).
 * payout = listing_price - sale_fee_amount - shipping_cost_amount - fixed_fee_amount
 *
 * @param {{
 *   listing_price: Decimal.Value | null | undefined;
 *   sale_fee_amount: Decimal.Value | null | undefined;
 *   shipping_cost_amount: Decimal.Value | null | undefined;
 *   fixed_fee_amount?: Decimal.Value | null | undefined;
 * }} p
 * @returns {Decimal | null}
 */
export function resolveMarketplacePayout(p) {
  const listing = dMoney(p?.listing_price);
  if (listing == null || !listing.isFinite() || listing.lt(0)) return null;
  const fee = dMoney(p?.sale_fee_amount) ?? new Decimal(0);
  const shipping = dMoney(p?.shipping_cost_amount) ?? new Decimal(0);
  const fixed = dMoney(p?.fixed_fee_amount) ?? new Decimal(0);
  const out = listing.minus(fee).minus(shipping).minus(fixed);
  if (!out.isFinite()) return null;
  return out;
}

/** @param {Record<string, unknown>} listing */
function listingTypeIdFromListing(listing) {
  if (listing.listing_type_id != null && String(listing.listing_type_id).trim() !== "") {
    return String(listing.listing_type_id).trim();
  }
  const raw = listing.raw_json;
  if (raw && typeof raw === "object") {
    const lt = /** @type {Record<string, unknown>} */ (raw).listing_type_id;
    if (lt != null && String(lt).trim() !== "") return String(lt).trim();
  }
  return null;
}

/**
 * @param {Record<string, unknown>} moneyShape
 * @param {Record<string, unknown> | null | undefined} health
 * @param {Record<string, unknown>} listing
 */
function resolveSaleFeePercentStr(moneyShape, health, listing) {
  const hp = mercadoLivreToFiniteGrid(health?.sale_fee_percent);
  if (hp != null && hp > 0) {
    return new Decimal(String(hp)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
  const feeShape = extractSaleFee(moneyShape, {
    listing,
    health,
  });
  if (feeShape.percent != null && feeShape.percent > 0) {
    return new Decimal(String(feeShape.percent)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
  return null;
}

/**
 * Coluna `sale_fee_amount` pode estar com bruto legado; `raw_json.raw_payloads.listing_prices_row`
 * guarda a linha oficial — re-coalesce (incl. `selling_fee` como objeto) alinha tarifa efetiva + subsídio.
 *
 * @param {Record<string, unknown> | null | undefined} health
 * @param {number | null | undefined} feeAmtFromColumn
 * @returns {number | null | undefined}
 */
function resolveFeeAmountForNetProceedsBreakdown(health, feeAmtFromColumn) {
  const n = mercadoLivreToFiniteGrid(feeAmtFromColumn);
  if (!health || typeof health !== "object") return n;
  const rj = health.raw_json;
  if (!rj || typeof rj !== "object") return n;
  const payloads = /** @type {Record<string, unknown>} */ (rj).raw_payloads;
  if (!payloads || typeof payloads !== "object") return n;
  const row = payloads.listing_prices_row;
  if (!row || typeof row !== "object") return n;
  const fromRow = coalesceListingPricesPersistedFeeAmount(/** @type {Record<string, unknown>} */ (row));
  if (fromRow == null || fromRow <= 0) return n;
  if (n == null) return fromRow;
  if (fromRow < n - 0.001) return fromRow;
  return n;
}

/**
 * @param {Record<string, unknown> | null | undefined} health
 * @returns {number | null}
 */
function resolveOfficialShippingFromListingPricesRow(health) {
  if (!health || typeof health !== "object") return null;
  const rj = health.raw_json;
  if (!rj || typeof rj !== "object") return null;
  const payloads = /** @type {Record<string, unknown>} */ (rj).raw_payloads;
  if (!payloads || typeof payloads !== "object") return null;
  const row = payloads.listing_prices_row;
  if (!row || typeof row !== "object") return null;
  const extId = health.external_listing_id != null ? String(health.external_listing_id).trim() : null;
  return extractMercadoLivreOfficialShippingFromListingPricesRow(
    /** @type {Record<string, unknown>} */ (row),
    { listing_id: extId, logContext: "ml_net_proceeds_resolve_official_lp_row" }
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} health
 * @returns {number | null}
 */
function resolveOfficialShippingFromOptionsFree(health) {
  if (!health || typeof health !== "object") return null;
  const rj = health.raw_json;
  if (!rj || typeof rj !== "object") return null;
  const payloads = /** @type {Record<string, unknown>} */ (rj).raw_payloads;
  if (!payloads || typeof payloads !== "object") return null;
  const so = payloads.shipping_options_free;
  if (!so || typeof so !== "object") return null;
  const rec = /** @type {Record<string, unknown>} */ (so);
  return mercadoLivreToFiniteGrid(rec.payable_cost ?? rec.list_cost);
}

/**
 * Subsídio ML exibido no Raio-X ("redução aplicada aos seus custos"): colunas health,
 * breakdown (bruto − API) ou linha bruta vs efetiva em raw_payloads.listing_prices_row.
 *
 * @param {Record<string, unknown> | null | undefined} health
 * @param {Record<string, string | null | undefined> | null} [feeBreakdownFields]
 */
function marketplaceCostReductionForPayload(health, feeBreakdownFields = null) {
  const discRaw = feeBreakdownFields?.marketplace_fee_discount_amount;
  if (discRaw != null && String(discRaw).trim() !== "") {
    try {
      const d = new Decimal(String(discRaw).trim());
      if (d.isFinite() && d.gt("0.0005")) {
        return {
          amount_str: d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
          source: "ml_fee_breakdown_gross_minus_effective_fee",
          label: "Redução aplicada pelo marketplace",
        };
      }
    } catch {
      /* noop */
    }
  }
  if (health && typeof health === "object") {
    const hAmt = mercadoLivreToFiniteGrid(
      /** @type {Record<string, unknown>} */ (health).marketplace_cost_reduction_amount ??
        /** @type {Record<string, unknown>} */ (health).marketplace_cost_reduction_amount_brl
    );
    if (hAmt != null && hAmt > 0.0005) {
      const lblRaw = /** @type {Record<string, unknown>} */ (health).marketplace_cost_reduction_label;
      const srcRaw = /** @type {Record<string, unknown>} */ (health).marketplace_cost_reduction_source;
      return {
        amount_str: decToApiStr(new Decimal(String(hAmt))),
        source:
          srcRaw != null && String(srcRaw).trim() !== ""
            ? String(srcRaw).trim()
            : "marketplace_listing_health_column",
        label:
          lblRaw != null && String(lblRaw).trim() !== ""
            ? String(lblRaw).trim()
            : "Redução aplicada pelo marketplace",
      };
    }
  }
  const rj = health && typeof health === "object" ? /** @type {Record<string, unknown>} */ (health).raw_json : null;
  if (!rj || typeof rj !== "object") return { amount_str: null, source: null, label: null };
  const pay = /** @type {Record<string, unknown>} */ (rj).raw_payloads;
  if (!pay || typeof pay !== "object") return { amount_str: null, source: null, label: null };
  const row = pay.listing_prices_row;
  const meta = extractMercadoLivreMarketplaceCostReductionFromListingPricesRow(
    row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : null
  );
  if (meta.amount_brl != null && meta.amount_brl > 0.0005) {
    return {
      amount_str: decToApiStr(new Decimal(String(meta.amount_brl))),
      source: meta.source ?? "ml_listing_prices_row",
      label: "Redução aplicada pelo marketplace",
    };
  }
  return { amount_str: null, source: null, label: null };
}

/**
 * @param {Record<string, unknown> | null | undefined} health
 */
function marketplacePayoutSourceFromHealth(health) {
  if (!health || typeof health !== "object") return null;
  const s = /** @type {Record<string, unknown>} */ (health).marketplace_payout_source;
  return s != null && String(s).trim() !== "" ? String(s).trim() : null;
}

/** @param {Record<string, unknown> | undefined} moneyShape */
function freeShippingFlagFromMoneyShape(moneyShape, health = null) {
  if (health && typeof health === "object") {
    const c = health.shipping_cost_context;
    if (c === "free_for_buyer") return true;
    if (c === "buyer_pays") return false;
  }
  const sh = moneyShape && typeof moneyShape === "object" ? moneyShape.shipping : null;
  if (!sh || typeof sh !== "object") return null;
  if (sh.free_shipping === true) return true;
  if (sh.free_shipping === false) return false;
  return null;
}

function feeBreakdownToNetProceedsFields(b) {
  return {
    sale_price_effective: b.sale_price_effective,
    sale_fee_percent: b.sale_fee_percent,
    sale_fee_label: b.sale_fee_label,
    gross_fee_amount: b.gross_fee_amount,
    marketplace_fee_discount_amount: b.marketplace_fee_discount_amount,
    sale_fee_amount_api: b.sale_fee_amount_api,
    sale_fee_validation_status: b.sale_fee_validation_status,
    sale_fee_difference_amount: b.sale_fee_difference_amount,
    marketplace_fee_source: b.marketplace_fee_source,
    calculation_confidence: b.calculation_confidence,
    shipping_cost_marketplace: b.shipping_cost_marketplace,
    fixed_fee_amount: b.fixed_fee_amount,
  };
}

/**
 * Fecha o contrato API: has_valid_data, validação numérica e alinhamento source/reason (front usa só has_valid_data).
 * @param {Omit<ListingNetProceedsPayload, "has_valid_data"> & { has_valid_data?: boolean }} p
 * @param {Record<string, unknown>} listing
 * @returns {ListingNetProceedsPayload}
 */
function finalizeNetProceedsPayload(p, listing) {
  const extId = String(listing?.external_listing_id ?? listing?.id ?? "").trim();
  const reasonRaw = p.insufficient_reason != null ? String(p.insufficient_reason).trim() : "";

  const saleD = dMoney(p.sale_price);
  const feeD = dMoney(p.sale_fee_amount);
  const pctD = dMoney(p.sale_fee_percent);
  const netD = dMoney(p.net_proceeds_amount);

  const saleOk = saleD != null && saleD.gte(0);
  const feeFromAmt = feeD != null && feeD.gte(0);
  const feeFromPct = pctD != null && pctD.gt(0);
  const hasFee = feeFromAmt || feeFromPct;
  const netOk = netD != null && netD.gte(0);

  const markedInsufficient = p.source === "insufficient_data" || reasonRaw !== "";

  /** Contrato: repasse válido = taxa (R$ ou %) + líquido; preço de venda obrigatório para o modal. */
  let has_valid_data =
    !markedInsufficient && hasFee && netOk && saleOk;

  /** @type {ListingNetProceedsPayload} */
  let out = {
    ...p,
    sale_fee_percent: p.sale_fee_percent ?? null,
    has_valid_data,
  };

  if (!has_valid_data) {
    const preservedReason =
      reasonRaw ||
      (markedInsufficient
        ? "Dados financeiros insuficientes para exibição do repasse."
        : "Valores de repasse inconsistentes (preço, tarifa ou líquido). Confira a sincronização do anúncio.");

    out = {
      ...out,
      has_valid_data: false,
      source: /** @type {NetProceedsSource} */ ("insufficient_data"),
      insufficient_reason: preservedReason,
    };
  } else {
    out.insufficient_reason = null;
  }

  if (mlFeeValidateLogsEnabled()) {
    console.info("[ML_FEE_VALIDATE][net_proceeds_final]", {
      external_listing_id: extId || null,
      has_valid_data: out.has_valid_data,
      source: out.source,
      sale_price: out.sale_price ?? null,
      sale_fee_amount: out.sale_fee_amount ?? null,
      sale_fee_percent: out.sale_fee_percent ?? null,
      net_proceeds_amount: out.net_proceeds_amount ?? null,
    });
  }

  return out;
}

/**
 * Teto de preço para validar comissão média importada: preço efetivo do anúncio ou, quando maior,
 * ticket médio bruto (`gross_revenue_total / qty`). Evita rejeitar fallback após queda de preço
 * ou divergência listing × histórico de pedidos.
 *
 * @param {Record<string, unknown>} metrics
 * @param {Decimal} saleDec
 * @param {number} qty
 * @returns {Decimal}
 */
function importedOrdersCommissionPriceCeiling(metrics, saleDec, qty) {
  let priceCeiling = saleDec;
  const grossTotal = dMoney(metrics.gross_revenue_total);
  if (grossTotal != null && grossTotal.isFinite() && grossTotal.gt(0) && qty >= 1) {
    const grossUnit = grossTotal.div(qty);
    if (grossUnit.isFinite() && grossUnit.gt(priceCeiling)) priceCeiling = grossUnit;
  }
  return priceCeiling;
}

/**
 * Fallback: comissão média por unidade vendida (pedidos importados em listing_sales_metrics).
 * Não substitui taxa do ML quando esta existir — só é chamado quando feeDec permanece null.
 *
 * @param {Record<string, unknown> | null | undefined} metrics
 * @param {Decimal} saleDec
 * @param {Decimal | null} originalDec
 * @returns {{ ok: true; payload: Omit<ListingNetProceedsPayload, "has_valid_data"> } | { ok: false; reason: string; detail?: Record<string, unknown> }}
 */
function computeImportedOrdersNetProceedsDraft(metrics, saleDec, originalDec) {
  if (!metrics || typeof metrics !== "object") {
    return { ok: false, reason: "no_metrics" };
  }

  const qtyRaw = metrics.qty_sold_total;
  const qty = qtyRaw != null ? Math.trunc(Number(qtyRaw)) : 0;
  if (!Number.isFinite(qty) || qty < 1) {
    return { ok: false, reason: "qty_sold_total_invalid", detail: { qty_sold_total: qtyRaw ?? null } };
  }

  const commTotal = dMoney(
    metrics.commission_amount_total ?? metrics.commission_amount_total_brl
  );
  if (commTotal == null || !commTotal.isFinite() || commTotal.lte(0)) {
    return {
      ok: false,
      reason: "commission_total_missing_or_nonpositive",
      detail: {
        commission_amount_total: metrics.commission_amount_total ?? null,
        commission_amount_total_brl: metrics.commission_amount_total_brl ?? null,
      },
    };
  }

  const commissionUnit = commTotal.div(qty);
  if (!commissionUnit.isFinite() || commissionUnit.lte(0)) {
    return { ok: false, reason: "commission_unit_invalid" };
  }

  const priceCeiling = importedOrdersCommissionPriceCeiling(
    /** @type {Record<string, unknown>} */ (metrics),
    saleDec,
    qty
  );
  const maxFee = priceCeiling.plus(EPS_MATCH);
  if (commissionUnit.gt(maxFee)) {
    return {
      ok: false,
      reason: "commission_unit_exceeds_price_ceiling",
      detail: {
        commission_unit: decToApiStr(commissionUnit),
        sale_price: decToApiStr(saleDec),
        price_ceiling: decToApiStr(priceCeiling),
      },
    };
  }

  const grossTotal = dMoney(metrics.gross_revenue_total);
  if (grossTotal != null && grossTotal.isFinite() && grossTotal.gt(0)) {
    const grossUnit = grossTotal.div(qty);
    if (grossUnit.isFinite() && commissionUnit.gt(grossUnit.plus(EPS_MATCH))) {
      return {
        ok: false,
        reason: "commission_exceeds_avg_gross_per_unit",
        detail: {
          commission_unit: decToApiStr(commissionUnit),
          gross_unit: decToApiStr(grossUnit),
        },
      };
    }
  }

  let shipUnit = new Decimal(0);
  const shipTotal = dMoney(metrics.shipping_share_total ?? metrics.shipping_share_total_brl);
  if (shipTotal != null && shipTotal.isFinite() && shipTotal.gt(0)) {
    const su = shipTotal.div(qty);
    if (su.isFinite() && su.gte(0)) shipUnit = su;
  }

  let netFinal = saleDec.minus(commissionUnit).minus(shipUnit);
  if (!netFinal.isFinite() || netFinal.lt(0)) {
    shipUnit = new Decimal(0);
    netFinal = saleDec.minus(commissionUnit);
  }
  if (!netFinal.isFinite() || netFinal.lt(0)) {
    return {
      ok: false,
      reason: "net_proceeds_negative_after_fee",
      detail: {
        commission_unit: decToApiStr(commissionUnit),
        sale_price: decToApiStr(saleDec),
      },
    };
  }

  const pctFromSale =
    saleDec.gt(0)
      ? commissionUnit.div(saleDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : null;

  const shipMarketStr = shipUnit.gt(0) ? decToApiStr(shipUnit) : "0.00";
  const ordersShipBlob = mercadoLivreShippingCostOfficialToPersistBlob({
    label: ML_SHIPPING_COST_OFFICIAL_LABEL,
    context: "buyer_pays",
    amount_brl: shipUnit.gt(0) ? decToApiStr(shipUnit) : null,
    source: "orders_metrics_pro_rata",
    decision_source: "shipping_share_total_div_qty",
    inconsistency_codes: [],
  });
  /** @type {Omit<ListingNetProceedsPayload, "has_valid_data">} */
  const payload = {
    sale_price: decToApiStr(saleDec),
    original_price: decToApiStr(originalDec),
    sale_price_effective: decToApiStr(saleDec),
    sale_fee_amount: decToApiStr(commissionUnit),
    sale_fee_percent: pctFromSale,
    sale_fee_label: null,
    gross_fee_amount: decToApiStr(commissionUnit),
    marketplace_fee_discount_amount: "0.00",
    sale_fee_amount_api: null,
    sale_fee_validation_status: "missing_api_value",
    sale_fee_difference_amount: "0.00",
    marketplace_fee_source: "calculated",
    calculation_confidence: "medium",
    suse7_shipping_cost: ordersShipBlob,
    ml_shipping_cost_label: ML_SHIPPING_COST_OFFICIAL_LABEL,
    ml_shipping_cost_context: "buyer_pays",
    ml_shipping_cost_amount_brl: shipUnit.gt(0) ? decToApiStr(shipUnit) : null,
    ml_shipping_cost_source: "orders_metrics_pro_rata",
    shipping_cost_amount: shipUnit.gt(0) ? decToApiStr(shipUnit) : null,
    shipping_cost_amount_brl: shipUnit.gt(0) ? decToApiStr(shipUnit) : null,
    shipping_cost_currency: "BRL",
    shipping_cost_source: "orders_metrics_pro_rata",
    shipping_cost_context: "buyer_pays",
    shipping_cost_label: ML_SHIPPING_COST_OFFICIAL_LABEL,
    shipping_cost_marketplace: shipMarketStr,
    fixed_fee_amount: "0.00",
    marketplace_payout: decToApiStr(netFinal),
    marketplace_payout_amount: decToApiStr(netFinal),
    marketplace_payout_amount_brl: decToApiStr(netFinal),
    marketplace_payout_source: "orders_metrics_pro_rata",
    marketplace_cost_reduction_amount: null,
    marketplace_cost_reduction_amount_brl: null,
    marketplace_cost_reduction_source: null,
    marketplace_cost_reduction_label: null,
    net_proceeds_amount: decToApiStr(netFinal),
    currency: CURRENCY,
    is_estimated: true,
    source: /** @type {NetProceedsSource} */ ("orders_fallback"),
    insufficient_reason: null,
  };

  return { ok: true, payload };
}

/**
 * Repasse unitário a partir das colunas persistidas em marketplace_listing_health (fonte após sync/backfill).
 * - sale_fee_amount / sale_fee_percent: banco
 * - shipping_cost: banco (null na API se 0 ou ausente — cálculo usa 0)
 * - net_proceeds_amount: preferir net_receivable do banco quando ≤ preço de venda e coerente com (preço − taxa − frete); senão componentes do banco.
 * Não usa métricas de pedidos importados (fallback `orders_fallback` é tratado à parte quando não há taxa ML).
 *
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @param {Decimal} saleDec
 * @param {Decimal | null} originalDec
 * @param {(p: ListingNetProceedsPayload, ctx?: Record<string, unknown>) => ListingNetProceedsPayload} withDebugLog
 * @param {(reason: string) => ListingNetProceedsPayload} emptyProceeds
 * @param {{ listing_price: number; promotion_price: number | null } | null} [feeAuditBase]
 * @returns {ListingNetProceedsPayload | null}
 */
function tryNetProceedsFromPersistedHealth(
  listing,
  health,
  saleDec,
  originalDec,
  withDebugLog,
  emptyProceeds,
  feeAuditBase = null
) {
  if (!health || typeof health !== "object") return null;
  const feeAmt = mercadoLivreToFiniteGrid(health.sale_fee_amount);
  const feePct = mercadoLivreToFiniteGrid(health.sale_fee_percent);
  if ((feeAmt == null || feeAmt <= 0) && (feePct == null || feePct <= 0)) return null;

  const feeAmtForBreakdown = resolveFeeAmountForNetProceedsBreakdown(health, feeAmt) ?? feeAmt;

  const extId = String(listing?.external_listing_id ?? listing?.id ?? "").trim();
  const moneyShapeMini = coalesceMercadoLibreItemForMoneyExtract(
    mercadoLivreListingPayloadForMoneyFields(listing, health)
  );
  const fromItemShip = extractShippingCost(moneyShapeMini);
  const saleFeeDetailsForShip =
    mercadoLivreListingPricesRowSaleFeeDetails(/** @type {Record<string, unknown>} */ (health)) ??
    moneyShapeMini.sale_fee_details;
  const fromSaleFeeDetShip = extractMercadoLivreLogisticsSellerCost(saleFeeDetailsForShip, {
    listing_id: extId || null,
    logContext: "ml_net_proceeds_from_health",
  });
  const fromOfficialListingPricesShip = resolveOfficialShippingFromListingPricesRow(health);
  const fromOfficialOptionsFreeShip = resolveOfficialShippingFromOptionsFree(health);
  const fromHealthShip = mercadoLivreToFiniteGrid(health.shipping_cost);
  const netRecvNum = mercadoLivreToFiniteGrid(health.net_receivable);

  const listingTypeId = listingTypeIdFromListing(/** @type {Record<string, unknown>} */ (listing));

  /** @type {Record<string, string | null | undefined>} */
  let breakdown = {};

  let feeDec;
  let officialShipRow = null;

  try {
    if (feePct != null && feePct > 0) {
      const feePctOutStr = new Decimal(String(feePct)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
      const saleFeeLabel = formatMercadoLivreSaleFeeLabel(listingTypeId, feePctOutStr);
      const b0 = buildMercadoLivreFeeBreakdown({
        sale_price_effective: saleDec.toNumber(),
        marketplace_fee_percent: feePct,
        marketplace_fee_amount_api:
          feeAmtForBreakdown != null && feeAmtForBreakdown > 0 ? feeAmtForBreakdown : null,
        shipping_cost_marketplace: 0,
        fixed_fee_amount: 0,
        listing_id: extId || null,
        sale_fee_label: saleFeeLabel,
        audit_listing_price: feeAuditBase?.listing_price ?? null,
        audit_promotion_price: feeAuditBase?.promotion_price ?? null,
      });
      feeDec = new Decimal(b0.sale_fee_amount);
      officialShipRow = resolveMercadoLivreShippingCostOfficial({
        listing_id: extId || null,
        logContext: "ml_net_proceeds_persisted_health",
        shipping_logistic_type:
          (moneyShapeMini?.shipping &&
          typeof moneyShapeMini.shipping === "object" &&
          /** @type {Record<string, unknown>} */ (moneyShapeMini.shipping).logistic_type != null
            ? String(/** @type {Record<string, unknown>} */ (moneyShapeMini.shipping).logistic_type)
            : health?.shipping_logistic_type != null
              ? String(health.shipping_logistic_type)
              : null),
        listing_status:
          listing?.status != null && String(listing.status).trim() !== "" ? String(listing.status).trim() : null,
        available_quantity:
          listing?.available_quantity != null && Number.isFinite(Number(listing.available_quantity))
            ? Number(listing.available_quantity)
            : null,
        fromShippingOptionsFree: fromOfficialOptionsFreeShip,
        fromOfficialMl: fromOfficialListingPricesShip,
        fromSaleFeeDetails: fromSaleFeeDetShip,
        fromMlItem: fromItemShip,
        fromHealth: fromHealthShip,
        gap:
          netRecvNum != null && Number.isFinite(netRecvNum) && netRecvNum >= 0
            ? { sale: saleDec, fee: feeDec, net: new Decimal(netRecvNum) }
            : null,
        free_shipping: freeShippingFlagFromMoneyShape(moneyShapeMini, health),
      });
      const shipN = Number(officialShipRow.amount_brl ?? 0);
      const b = buildMercadoLivreFeeBreakdown({
        sale_price_effective: saleDec.toNumber(),
        marketplace_fee_percent: feePct,
        marketplace_fee_amount_api:
          feeAmtForBreakdown != null && feeAmtForBreakdown > 0 ? feeAmtForBreakdown : null,
        shipping_cost_marketplace: shipN,
        fixed_fee_amount: 0,
        listing_id: extId || null,
        sale_fee_label: saleFeeLabel,
        audit_listing_price: feeAuditBase?.listing_price ?? null,
        audit_promotion_price: feeAuditBase?.promotion_price ?? null,
      });
      feeDec = new Decimal(b.sale_fee_amount);
      breakdown = feeBreakdownToNetProceedsFields(b);
    } else if (feeAmt != null && feeAmt > 0) {
      const saleFeeLabel = formatMercadoLivreSaleFeeLabel(listingTypeId, null);
      const b0 = buildMercadoLivreFeeBreakdown({
        sale_price_effective: saleDec.toNumber(),
        marketplace_fee_percent: null,
        marketplace_fee_amount_api: feeAmtForBreakdown,
        shipping_cost_marketplace: 0,
        fixed_fee_amount: 0,
        listing_id: extId || null,
        sale_fee_label: saleFeeLabel,
        audit_listing_price: feeAuditBase?.listing_price ?? null,
        audit_promotion_price: feeAuditBase?.promotion_price ?? null,
      });
      feeDec = new Decimal(b0.sale_fee_amount);
      officialShipRow = resolveMercadoLivreShippingCostOfficial({
        listing_id: extId || null,
        logContext: "ml_net_proceeds_persisted_health",
        shipping_logistic_type:
          (moneyShapeMini?.shipping &&
          typeof moneyShapeMini.shipping === "object" &&
          /** @type {Record<string, unknown>} */ (moneyShapeMini.shipping).logistic_type != null
            ? String(/** @type {Record<string, unknown>} */ (moneyShapeMini.shipping).logistic_type)
            : health?.shipping_logistic_type != null
              ? String(health.shipping_logistic_type)
              : null),
        listing_status:
          listing?.status != null && String(listing.status).trim() !== "" ? String(listing.status).trim() : null,
        available_quantity:
          listing?.available_quantity != null && Number.isFinite(Number(listing.available_quantity))
            ? Number(listing.available_quantity)
            : null,
        fromShippingOptionsFree: fromOfficialOptionsFreeShip,
        fromOfficialMl: fromOfficialListingPricesShip,
        fromSaleFeeDetails: fromSaleFeeDetShip,
        fromMlItem: fromItemShip,
        fromHealth: fromHealthShip,
        gap:
          netRecvNum != null && Number.isFinite(netRecvNum) && netRecvNum >= 0
            ? { sale: saleDec, fee: feeDec, net: new Decimal(netRecvNum) }
            : null,
        free_shipping: freeShippingFlagFromMoneyShape(moneyShapeMini, health),
      });
      const shipN = Number(officialShipRow.amount_brl ?? 0);
      const b = buildMercadoLivreFeeBreakdown({
        sale_price_effective: saleDec.toNumber(),
        marketplace_fee_percent: null,
        marketplace_fee_amount_api: feeAmtForBreakdown,
        shipping_cost_marketplace: shipN,
        fixed_fee_amount: 0,
        listing_id: extId || null,
        sale_fee_label: saleFeeLabel,
        audit_listing_price: feeAuditBase?.listing_price ?? null,
        audit_promotion_price: feeAuditBase?.promotion_price ?? null,
      });
      feeDec = new Decimal(b.sale_fee_amount);
      breakdown = feeBreakdownToNetProceedsFields(b);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  if (
    feeDec == null ||
    !feeDec.isFinite() ||
    feeDec.lte(0) ||
    officialShipRow == null ||
    officialShipRow.amount_brl == null
  ) {
    return null;
  }

  const shipDed = new Decimal(officialShipRow.amount_brl ?? 0);
  const fixedFeeDed = dMoney(breakdown.fixed_fee_amount) ?? new Decimal(0);
  const netCalc =
    resolveMarketplacePayout({
      listing_price: saleDec,
      sale_fee_amount: feeDec,
      shipping_cost_amount: shipDed,
      fixed_fee_amount: fixedFeeDed,
    }) ?? saleDec.minus(feeDec).minus(shipDed);

  let netFinal = netCalc;
  let isEstimated = false;
  /** `marketplace_payout_*` gravado no health — não sobrescrever por `net_receivable` defasado. */
  let usedMaterializedPayout = false;

  const payoutColNum = mercadoLivreToFiniteGrid(
    /** @type {Record<string, unknown>} */ (health).marketplace_payout_amount ??
      /** @type {Record<string, unknown>} */ (health).marketplace_payout_amount_brl
  );
  if (payoutColNum != null && Number.isFinite(payoutColNum) && payoutColNum >= 0) {
    const pDec = new Decimal(payoutColNum);
    if (!pDec.gt(saleDec)) {
      const diffP = pDec.minus(netCalc).abs();
      if (diffP.lte(EPS_MATCH)) {
        netFinal = pDec;
        usedMaterializedPayout = true;
      }
    }
  }

  if (netRecvNum != null && Number.isFinite(netRecvNum) && netRecvNum >= 0) {
    const nrd = new Decimal(netRecvNum);
    if (!nrd.gt(saleDec)) {
      const diff = nrd.minus(netCalc).abs();
      if (diff.lte(EPS_MATCH)) {
        netFinal = nrd;
      } else if (!usedMaterializedPayout) {
        netFinal = netCalc;
        isEstimated = true;
      }
    }
  }

  if (!netFinal.isFinite() || netFinal.lt(0)) {
    if (mlFeeValidateLogsEnabled()) {
      const extIdLog = String(listing?.external_listing_id ?? listing?.id ?? "").trim();
      console.info("[ML_FEE_VALIDATE][persisted_health_net_rejected_try_orders]", {
        external_listing_id: extIdLog || null,
        sale_price: decToApiStr(saleDec),
        fee_calc: decToApiStr(feeDec),
        shipping_brl: officialShipRow.amount_brl,
        net_calc: decToApiStr(netCalc),
      });
    }
    return null;
  }

  const shipFields = mercadoLivreShippingOfficialToNetProceedsFields(officialShipRow);
  const netOutStr = decToApiStr(netFinal);
  const cr = marketplaceCostReductionForPayload(/** @type {Record<string, unknown>} */ (health), breakdown);
  const payoutSrc =
    marketplacePayoutSourceFromHealth(/** @type {Record<string, unknown>} */ (health)) ??
    "marketplace_listing_health_net_proceeds";

  return withDebugLog(
    {
      sale_price: decToApiStr(saleDec),
      original_price: decToApiStr(originalDec),
      ...breakdown,
      ...shipFields,
      sale_fee_amount: decToApiStr(feeDec),
      net_proceeds_amount: netOutStr,
      marketplace_payout: netOutStr,
      marketplace_payout_amount: netOutStr,
      marketplace_payout_amount_brl: netOutStr,
      marketplace_payout_source: payoutSrc,
      marketplace_cost_reduction_amount: cr.amount_str,
      marketplace_cost_reduction_amount_brl: cr.amount_str,
      marketplace_cost_reduction_source: cr.source,
      marketplace_cost_reduction_label: cr.amount_str ? cr.label : null,
      currency: CURRENCY,
      is_estimated: isEstimated,
      source: /** @type {NetProceedsSource} */ ("marketplace_listing_health"),
      insufficient_reason: null,
    },
    {
      extra: {
        persisted_health_path: "marketplace_listing_health_columns",
        health_net_receivable_raw: health.net_receivable ?? null,
        net_calc_from_db_components: decToApiStr(netCalc),
      },
    }
  );
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @param {Record<string, unknown> | null | undefined} [metrics] listing_sales_metrics (comissão/qty importadas)
 * @returns {ListingNetProceedsPayload}
 */
export function computeMercadoLivreUnitNetProceeds(listing, health, metrics = null) {
  /** @type {(reason: string) => ListingNetProceedsPayload} */
  const emptyProceeds = (reason) => ({
    sale_price: null,
    original_price: null,
    sale_price_effective: null,
    sale_fee_amount: null,
    sale_fee_percent: null,
    sale_fee_label: null,
    gross_fee_amount: null,
    marketplace_fee_discount_amount: null,
    sale_fee_amount_api: null,
    sale_fee_validation_status: null,
    sale_fee_difference_amount: null,
    marketplace_fee_source: null,
    calculation_confidence: null,
    shipping_cost_amount: null,
    shipping_cost_amount_brl: null,
    shipping_cost_currency: "BRL",
    shipping_cost_source: null,
    shipping_cost_context: null,
    shipping_cost_label: null,
    shipping_cost_marketplace: null,
    fixed_fee_amount: null,
    suse7_shipping_cost: null,
    ml_shipping_cost_label: null,
    ml_shipping_cost_context: null,
    ml_shipping_cost_amount_brl: null,
    ml_shipping_cost_source: null,
    marketplace_payout: null,
    marketplace_payout_amount: null,
    marketplace_payout_amount_brl: null,
    marketplace_payout_source: null,
    marketplace_cost_reduction_amount: null,
    marketplace_cost_reduction_amount_brl: null,
    marketplace_cost_reduction_source: null,
    marketplace_cost_reduction_label: null,
    net_proceeds_amount: null,
    currency: CURRENCY,
    is_estimated: false,
    source: /** @type {const} */ ("insufficient_data"),
    insufficient_reason: reason,
  });

  /** @type {Decimal | null} */
  let netOfficialRawDec = null;
  /** @type {string | null} */
  let netOfficialDiscardedReason = null;

  const moneyShapeBase = coalesceMercadoLibreItemForMoneyExtract(
    mercadoLivreListingPayloadForMoneyFields(listing, health)
  );
  const priceCandidate = mercadoLivrePickListingPriceCandidate(listing);
  const moneyShape = {
    ...moneyShapeBase,
    price:
      moneyShapeBase.price != null && moneyShapeBase.price !== ""
        ? moneyShapeBase.price
        : priceCandidate ?? null,
  };

  /**
   * @param {ListingNetProceedsPayload} payload
   * @param {Record<string, unknown>} ctx
   */
  const withDebugLog = (payload, ctx = {}) => {
    const finalized = finalizeNetProceedsPayload(
      /** @type {Omit<ListingNetProceedsPayload, "has_valid_data"> & { has_valid_data?: boolean }} */ (payload),
      listing
    );
    const extIdDecision = String(listing?.external_listing_id ?? listing?.id ?? "").trim();
    if (mlFeeFinalDecisionLogEnabled(extIdDecision)) {
      console.info(
        "[ML_FEE_FINAL_DECISION]",
        JSON.stringify({
          stage: "net_proceeds_after_finalize",
          listing_id: extIdDecision,
          sale_price_effective: finalized.sale_price_effective ?? null,
          sale_fee_percent: finalized.sale_fee_percent ?? null,
          gross_fee_amount: finalized.gross_fee_amount ?? null,
          marketplace_fee_discount_amount: finalized.marketplace_fee_discount_amount ?? null,
          sale_fee_amount: finalized.sale_fee_amount ?? null,
          sale_fee_amount_api: finalized.sale_fee_amount_api ?? null,
          net_proceeds_amount: finalized.net_proceeds_amount ?? null,
          marketplace_payout: finalized.marketplace_payout ?? null,
          source: finalized.source ?? null,
          has_valid_data: finalized.has_valid_data ?? null,
          marketplace_fee_source: finalized.marketplace_fee_source ?? null,
          calculation_confidence: finalized.calculation_confidence ?? null,
        })
      );
    }
    if (!mlNetProceedsShouldDebug(listing)) return finalized;
    const feeFromShape = extractSaleFee(moneyShape, {
      listing: /** @type {Record<string, unknown>} */ (listing),
      health,
    });
    /** @type {Record<string, unknown>} */
    let diag = {};
    try {
      diag = /** @type {Record<string, unknown>} */ (
        mercadoLivreMoneyShapeDiagnostics(
          /** @type {Record<string, unknown>} */ (listing),
          /** @type {Record<string, unknown> | null | undefined} */ (health)
        ) ?? {}
      );
    } catch {
      diag = { money_diagnostics_error: true };
    }
    const row = {
      listing_id: String(listing?.external_listing_id ?? listing?.id ?? ""),
      sale_price_candidate: ctx.sale_price_candidate ?? null,
      original_price_candidate: ctx.original_price_candidate ?? null,
      sale_fee_amount_resolved:
        ctx.fee_amount_candidate ?? (feeFromShape.amount != null ? String(feeFromShape.amount) : null),
      sale_fee_percent_resolved:
        ctx.fee_percent_candidate ??
        (feeFromShape.percent != null ? String(feeFromShape.percent) : null),
      shipping_cost_candidate: ctx.shipping_cost_candidate ?? null,
      net_official_candidate_raw: ctx.net_official_candidate_raw ?? null,
      net_official_discarded_reason:
        ctx.net_official_discarded_reason ?? netOfficialDiscardedReason,
      health_sale_fee_amount_raw: health?.sale_fee_amount ?? null,
      health_sale_fee_percent_raw: health?.sale_fee_percent ?? null,
      health_net_receivable_raw: health?.net_receivable ?? null,
      health_shipping_cost_raw: health?.shipping_cost ?? null,
      health_promotion_price_raw: health?.promotion_price ?? null,
      insufficient_reason_final: finalized.insufficient_reason ?? null,
      source_final: finalized.source,
      has_valid_data_final: finalized.has_valid_data,
      net_proceeds_amount_final: finalized.net_proceeds_amount ?? null,
    };
    const extra = ctx.extra && typeof ctx.extra === "object" ? ctx.extra : {};
    console.info("[ML_NET_PROCEEDS_DEBUG]", { ...diag, ...row, ...extra });
    return finalized;
  };

  const priceStrRaw = priceCandidate ?? moneyShape.price;
  const listDec = (() => {
    const n = mercadoLivreToFiniteGrid(priceStrRaw);
    if (n != null && n > 0) return new Decimal(n);
    const d = dMoney(priceStrRaw);
    if (d != null && d.gt(0)) return d;
    return null;
  })();

  if (listDec == null || listDec.lte(0)) {
    return withDebugLog(emptyProceeds("Preço de venda do anúncio não disponível para calcular o repasse."), {
      sale_price_candidate: decToApiStr(listDec),
    });
  }

  const promoNumHealth = mercadoLivreToFiniteGrid(health?.promotion_price);
  const promoFromItem = extractPromotionPrice(moneyShape);
  const promoDec =
    promoNumHealth != null && promoNumHealth > 0
      ? new Decimal(promoNumHealth)
      : promoFromItem != null && promoFromItem > 0
        ? new Decimal(String(promoFromItem))
        : null;

  const listingPriceNum = listDec.toNumber();
  const promotionPriceNum =
    promoDec != null && promoDec.gt(0) ? promoDec.toNumber() : null;
  const hasActivePromotion =
    promotionPriceNum != null &&
    promotionPriceNum > 0 &&
    promotionPriceNum < listingPriceNum;

  const officialUnitPrice = resolveMercadoLivreSalePriceOfficial({
    marketplace: "mercado_livre",
    listing_id: String(listing?.external_listing_id ?? listing?.id ?? "").trim() || null,
    user_id:
      listing?.user_id != null
        ? String(/** @type {Record<string, unknown>} */ (listing).user_id)
        : null,
    marketplace_account_id: null,
    listing_price: listingPriceNum,
    promotion_price: promotionPriceNum,
    has_active_promotion_hint: hasActivePromotion,
    context: "ml_net_proceeds_unit",
  });

  let saleDec;
  if (officialUnitPrice.sale_price_effective != null) {
    saleDec = new Decimal(officialUnitPrice.sale_price_effective);
  } else {
    saleDec = listDec;
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.PRICING_FALLBACK_APPLIED, {
      marketplace: "mercado_livre",
      listing_id: officialUnitPrice.listing_id,
      user_id: officialUnitPrice.user_id,
      context: "ml_net_proceeds_sale_dec_fallback",
      message: "Preço efetivo oficial indisponível — usa candidato de lista do item",
    });
  }

  const feeAuditBase = {
    listing_price: listingPriceNum,
    promotion_price: officialUnitPrice.has_valid_promotion ? promotionPriceNum : null,
  };

  let originalDec = null;
  if (listing.original_price != null && String(listing.original_price).trim() !== "") {
    originalDec =
      dMoney(listing.original_price) ?? dMoney(String(listing.original_price).trim());
  } else if (moneyShape.original_price != null && String(moneyShape.original_price).trim() !== "") {
    originalDec = dMoney(moneyShape.original_price);
  } else if (listing.base_price != null && String(listing.base_price).trim() !== "") {
    originalDec = dMoney(listing.base_price);
  }
  if (originalDec != null && saleDec != null && originalDec.lte(saleDec)) {
    originalDec = null;
  }

  const fromPersisted = tryNetProceedsFromPersistedHealth(
    listing,
    health,
    saleDec,
    originalDec,
    withDebugLog,
    emptyProceeds,
    feeAuditBase
  );
  if (fromPersisted != null && fromPersisted.has_valid_data === true) return fromPersisted;

  /**
   * Sem tarifa persistida em `tryNetProceedsFromPersistedHealth`, só usamos campos explícitos do item
   * (`sale_fee_amount`, `sale_fee_details` de 1º nível) — não varremos JSON profundo, para não “achar”
   * taxa espúria e impedir `orders_fallback` quando listing_prices/health estão vazios.
   */
  const feeExtractOpts = {
    listing: /** @type {Record<string, unknown>} */ (listing),
    health,
    skipDeepExtract: true,
  };

  let feeDec = (() => {
    const hCol = mercadoLivreToFiniteGrid(health?.sale_fee_amount);
    const h = resolveFeeAmountForNetProceedsBreakdown(
      /** @type {Record<string, unknown> | null | undefined} */ (health),
      hCol
    );
    if (h != null && h > 0) return new Decimal(h);
    const feeItem = extractSaleFee(moneyShape, feeExtractOpts);
    if (feeItem.amount != null && feeItem.amount > 0) return new Decimal(String(feeItem.amount));
    return null;
  })();

  if (feeDec == null || !feeDec.isFinite() || feeDec.lte(0)) {
    const pctH = mercadoLivreToFiniteGrid(health?.sale_fee_percent);
    if (pctH != null && pctH > 0) feeDec = saleDec.mul(pctH).div(100);
  }
  if (feeDec == null || !feeDec.isFinite() || feeDec.lte(0)) {
    const feeItem = extractSaleFee(moneyShape, feeExtractOpts);
    if (feeItem.percent != null && feeItem.percent > 0) {
      feeDec = saleDec.mul(feeItem.percent).div(100);
    }
  }
  if (feeDec != null && (!feeDec.isFinite() || feeDec.lte(0))) feeDec = null;

  netOfficialRawDec = (() => {
    const nh = mercadoLivreToFiniteGrid(health?.net_receivable);
    if (nh != null && Number.isFinite(nh)) return new Decimal(nh);
    const ex = extractNetReceivableExplicit(moneyShape);
    if (ex != null && Number.isFinite(ex)) return new Decimal(String(ex));
    return null;
  })();

  let netOfficial = netOfficialRawDec;
  if (netOfficial != null && netOfficial.isFinite()) {
    if (netOfficial.gt(saleDec)) {
      netOfficialDiscardedReason = "exceeds_effective_sale_price";
      netOfficial = null;
    } else if (netOfficial.lt(0)) {
      netOfficialDiscardedReason = "negative";
      netOfficial = null;
    }
  }

  const feeForNetGap =
    feeDec != null && feeDec.isFinite() && feeDec.gt(0) ? feeDec : null;

  const saleFeeDetailsForShipCalc =
    mercadoLivreListingPricesRowSaleFeeDetails(/** @type {Record<string, unknown> | null | undefined} */ (health)) ??
    moneyShape.sale_fee_details;
  const officialLpShipCalc = resolveOfficialShippingFromListingPricesRow(
    /** @type {Record<string, unknown> | null | undefined} */ (health)
  );
  const officialOptShipCalc = resolveOfficialShippingFromOptionsFree(
    /** @type {Record<string, unknown> | null | undefined} */ (health)
  );
  const officialShipCalc = resolveMercadoLivreShippingCostOfficial({
    listing_id: String(listing?.external_listing_id ?? listing?.id ?? "").trim() || null,
    logContext: "ml_net_proceeds_calculated_path",
    shipping_logistic_type:
      (moneyShape?.shipping &&
      typeof moneyShape.shipping === "object" &&
      /** @type {Record<string, unknown>} */ (moneyShape.shipping).logistic_type != null
        ? String(/** @type {Record<string, unknown>} */ (moneyShape.shipping).logistic_type)
        : health?.shipping_logistic_type != null
          ? String(health.shipping_logistic_type)
          : null),
    listing_status:
      listing?.status != null && String(listing.status).trim() !== "" ? String(listing.status).trim() : null,
    available_quantity:
      listing?.available_quantity != null && Number.isFinite(Number(listing.available_quantity))
        ? Number(listing.available_quantity)
        : null,
    fromShippingOptionsFree: officialOptShipCalc,
    fromOfficialMl: officialLpShipCalc,
    fromSaleFeeDetails: extractMercadoLivreLogisticsSellerCost(saleFeeDetailsForShipCalc, {
      listing_id: String(listing?.external_listing_id ?? listing?.id ?? "").trim() || null,
      logContext: "ml_net_proceeds_calculated_path",
    }),
    fromMlItem: extractShippingCost(moneyShape),
    fromHealth: mercadoLivreToFiniteGrid(health?.shipping_cost),
    gap:
      feeForNetGap != null && netOfficial != null && netOfficial.isFinite()
        ? { sale: saleDec, fee: feeForNetGap, net: netOfficial }
        : null,
    free_shipping: freeShippingFlagFromMoneyShape(moneyShape, health),
  });
  if (officialShipCalc.amount_brl == null) {
    return withDebugLog(
      {
        ...emptyProceeds(
          "Custo de envio não confiável para este anúncio. Sincronize para recompor o frete oficial."
        ),
        sale_price: decToApiStr(saleDec),
        original_price: decToApiStr(originalDec),
        sale_fee_amount: decToApiStr(feeDec),
        sale_fee_percent: resolveSaleFeePercentStr(
          moneyShape,
          health,
          /** @type {Record<string, unknown>} */ (listing)
        ),
      },
      {
        sale_price_candidate: decToApiStr(saleDec),
        original_price_candidate: decToApiStr(originalDec),
        fee_amount_candidate: decToApiStr(feeDec),
        shipping_cost_candidate: null,
        extra: {
          shipping_resolution_source: officialShipCalc.source,
          shipping_resolution_decision_source: officialShipCalc.decision_source,
        },
      }
    );
  }

  const shipNum = Number(officialShipCalc.amount_brl ?? 0);
  const shipForNet = new Decimal(shipNum);
  const shipDec = shipForNet.gt(0) ? shipForNet : null;

  const saleFeePercentEarly = resolveSaleFeePercentStr(
    moneyShape,
    health,
    /** @type {Record<string, unknown>} */ (listing)
  );
  const apiFeeEarly = resolveFeeAmountForNetProceedsBreakdown(
    /** @type {Record<string, unknown> | null | undefined} */ (health),
    mercadoLivreToFiniteGrid(health?.sale_fee_amount)
  );
  /** @type {Record<string, string | null | undefined> | null} */
  let feeBreakdownExtra = null;

  if (feeDec != null && feeDec.isFinite() && feeDec.gt(0)) {
    if (saleFeePercentEarly != null) {
      try {
        const b = buildMercadoLivreFeeBreakdown({
          sale_price_effective: saleDec.toNumber(),
          marketplace_fee_percent: Number(saleFeePercentEarly),
          marketplace_fee_amount_api: apiFeeEarly != null && apiFeeEarly > 0 ? apiFeeEarly : null,
          shipping_cost_marketplace: shipNum,
          fixed_fee_amount: 0,
          listing_id: String(listing?.external_listing_id ?? listing?.id ?? ""),
          sale_fee_label: formatMercadoLivreSaleFeeLabel(
            listingTypeIdFromListing(/** @type {Record<string, unknown>} */ (listing)),
            saleFeePercentEarly
          ),
          audit_listing_price: feeAuditBase.listing_price,
          audit_promotion_price: feeAuditBase.promotion_price,
        });
        feeDec = new Decimal(b.sale_fee_amount);
        feeBreakdownExtra = feeBreakdownToNetProceedsFields(b);
      } catch {
        /* mantém feeDec resolvido pelo fluxo anterior */
      }
    } else if (apiFeeEarly != null && apiFeeEarly > 0) {
      try {
        const b = buildMercadoLivreFeeBreakdown({
          sale_price_effective: saleDec.toNumber(),
          marketplace_fee_percent: null,
          marketplace_fee_amount_api: apiFeeEarly,
          shipping_cost_marketplace: shipNum,
          fixed_fee_amount: 0,
          listing_id: String(listing?.external_listing_id ?? listing?.id ?? ""),
          sale_fee_label: formatMercadoLivreSaleFeeLabel(
            listingTypeIdFromListing(/** @type {Record<string, unknown>} */ (listing)),
            null
          ),
          audit_listing_price: feeAuditBase.listing_price,
          audit_promotion_price: feeAuditBase.promotion_price,
        });
        feeDec = new Decimal(b.sale_fee_amount);
        feeBreakdownExtra = feeBreakdownToNetProceedsFields(b);
      } catch {
        /* noop */
      }
    }
  }

  const feeForNet = feeDec ?? new Decimal(0);
  const fixedFeeForNet = dMoney(feeBreakdownExtra?.fixed_fee_amount) ?? new Decimal(0);
  const netCalc =
    resolveMarketplacePayout({
      listing_price: saleDec,
      sale_fee_amount: feeForNet,
      shipping_cost_amount: shipForNet,
      fixed_fee_amount: fixedFeeForNet,
    }) ?? saleDec.minus(feeForNet).minus(shipForNet);

  if (feeDec == null) {
    const extIdForOrders = String(listing?.external_listing_id ?? listing?.id ?? "").trim();
    const ordersDraft = computeImportedOrdersNetProceedsDraft(metrics, saleDec, originalDec);
    if (ordersDraft.ok) {
      const ordersPayload = ordersDraft.payload;
      if (mlFeeValidateLogsEnabled()) {
        console.info("[ML_FEE_VALIDATE][orders_fallback_used]", {
          external_listing_id: extIdForOrders || null,
          qty_sold_total: metrics?.qty_sold_total ?? null,
          commission_amount_total: metrics?.commission_amount_total ?? metrics?.commission_amount_total_brl ?? null,
          shipping_share_total: metrics?.shipping_share_total ?? metrics?.shipping_share_total_brl ?? null,
          commission_unit: ordersPayload.sale_fee_amount ?? null,
          shipping_unit: ordersPayload.shipping_cost_amount ?? null,
          net_proceeds_amount: ordersPayload.net_proceeds_amount ?? null,
          sale_price: ordersPayload.sale_price ?? null,
        });
      }
      return withDebugLog(ordersPayload, {
        sale_price_candidate: decToApiStr(saleDec),
        shipping_cost_candidate: shipDec ? decToApiStr(shipDec) : null,
        net_official_candidate_raw: netOfficialRawDec ? decToApiStr(netOfficialRawDec) : null,
        extra: { orders_fallback: true },
      });
    }

    if (mlFeeValidateLogsEnabled()) {
      console.info("[ML_FEE_VALIDATE][orders_fallback_skipped]", {
        external_listing_id: extIdForOrders || null,
        reason: ordersDraft.reason,
        ...(ordersDraft.detail && typeof ordersDraft.detail === "object" ? ordersDraft.detail : {}),
        qty_sold_total: metrics?.qty_sold_total ?? null,
        commission_amount_total: metrics?.commission_amount_total ?? metrics?.commission_amount_total_brl ?? null,
        gross_revenue_total: metrics?.gross_revenue_total ?? null,
      });
    }

    return withDebugLog(
      {
        ...emptyProceeds(
          "Tarifa de venda não disponível. Sincronize o anúncio para trazer o health do Mercado Livre."
        ),
        sale_price: decToApiStr(saleDec),
        original_price: decToApiStr(originalDec),
        sale_fee_percent: null,
      },
      {
        sale_price_candidate: decToApiStr(saleDec),
        original_price_candidate: decToApiStr(originalDec),
        shipping_cost_candidate: shipDec ? decToApiStr(shipDec) : null,
        net_official_candidate_raw: netOfficialRawDec ? decToApiStr(netOfficialRawDec) : null,
      }
    );
  }

  let netFinal = netCalc;
  let source = /** @type {NetProceedsSource} */ ("calculated");
  let isEstimated = false;

  if (netOfficial != null && netOfficial.isFinite()) {
    const diff = netOfficial.minus(netCalc).abs();
    if (diff.lte(EPS_MATCH)) {
      netFinal = netOfficial;
      source = "marketplace_api";
    } else {
      netFinal = netCalc;
      isEstimated = true;
    }
  }

  if (!netFinal.isFinite() || netFinal.lt(0)) {
    return withDebugLog(
      {
        ...emptyProceeds("Repasse calculado inconsistente; verifique preço, tarifa e frete do anúncio."),
        sale_price: decToApiStr(saleDec),
        original_price: decToApiStr(originalDec),
        sale_fee_amount: decToApiStr(feeDec),
        sale_fee_percent: null,
        shipping_cost_amount: officialShipCalc.amount_brl,
      },
      {
        sale_price_candidate: decToApiStr(saleDec),
        original_price_candidate: decToApiStr(originalDec),
        fee_amount_candidate: decToApiStr(feeDec),
        shipping_cost_candidate: shipDec ? decToApiStr(shipDec) : null,
        net_official_candidate_raw: netOfficialRawDec ? decToApiStr(netOfficialRawDec) : null,
      }
    );
  }

  const saleFeePercentStr =
    feeBreakdownExtra != null && feeBreakdownExtra.sale_fee_percent != null
      ? String(feeBreakdownExtra.sale_fee_percent)
      : resolveSaleFeePercentStr(moneyShape, health, /** @type {Record<string, unknown>} */ (listing));

  const netOutStr = decToApiStr(netFinal);

  const extendedFallback = {
    sale_price_effective: decToApiStr(saleDec),
    sale_fee_label:
      saleFeePercentStr != null
        ? formatMercadoLivreSaleFeeLabel(
            listingTypeIdFromListing(/** @type {Record<string, unknown>} */ (listing)),
            saleFeePercentStr
          )
        : null,
    gross_fee_amount: null,
    marketplace_fee_discount_amount: "0.00",
    sale_fee_amount_api: null,
    sale_fee_validation_status: "missing_api_value",
    sale_fee_difference_amount: "0.00",
    marketplace_fee_source: "calculated",
    calculation_confidence: "medium",
    shipping_cost_marketplace: shipForNet.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    fixed_fee_amount: "0.00",
  };

  const shipFieldsOut = mercadoLivreShippingOfficialToNetProceedsFields(officialShipCalc);
  const feeBreakdownMerged =
    feeBreakdownExtra != null ? { ...feeBreakdownExtra } : { ...extendedFallback };
  const crCalc = marketplaceCostReductionForPayload(
    /** @type {Record<string, unknown> | null | undefined} */ (health),
    feeBreakdownMerged
  );
  const payoutSrcCalc =
    source === "marketplace_api"
      ? "ml_item_net_receivable_explicit"
      : marketplacePayoutSourceFromHealth(
            /** @type {Record<string, unknown> | null | undefined> */ (health)
          ) ?? "net_proceeds_sale_minus_fee_minus_shipping";

  return withDebugLog(
    {
      sale_price: decToApiStr(saleDec),
      original_price: decToApiStr(originalDec),
      ...feeBreakdownMerged,
      ...shipFieldsOut,
      sale_fee_amount: decToApiStr(feeDec),
      sale_fee_percent: saleFeePercentStr,
      net_proceeds_amount: netOutStr,
      marketplace_payout: netOutStr,
      marketplace_payout_amount: netOutStr,
      marketplace_payout_amount_brl: netOutStr,
      marketplace_payout_source: payoutSrcCalc,
      marketplace_cost_reduction_amount: crCalc.amount_str,
      marketplace_cost_reduction_amount_brl: crCalc.amount_str,
      marketplace_cost_reduction_source: crCalc.source,
      marketplace_cost_reduction_label: crCalc.amount_str ? crCalc.label : null,
      currency: CURRENCY,
      is_estimated: isEstimated,
      source,
      insufficient_reason: null,
    },
    {
      sale_price_candidate: decToApiStr(saleDec),
      original_price_candidate: decToApiStr(originalDec),
      fee_amount_candidate: decToApiStr(feeDec),
      shipping_cost_candidate: shipDec ? decToApiStr(shipDec) : null,
      net_official_candidate_raw: netOfficialRawDec ? decToApiStr(netOfficialRawDec) : null,
      extra: {
        net_calc_candidate: decToApiStr(netCalc),
        net_final: decToApiStr(netFinal),
        is_estimated: isEstimated,
      },
    }
  );
}
