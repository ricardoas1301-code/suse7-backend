// ======================================================
// PRICING — guard clauses e validações monetárias (Suse7)
// ======================================================
// Decimal.js onde há comparação de limiares monetários.
// Multi-marketplace: hoje usado pelo núcleo ML; extensões futuras reutilizam guards.
// ======================================================

import Decimal from "decimal.js";
import {
  logPricingEvent,
  PRICING_EVENT_CODE,
  PRICING_LOG_LEVEL,
} from "./pricingInconsistencyLog.js";

/**
 * Normaliza entrada monetária positiva finita (evita Number puro para decisão).
 * @param {unknown} v
 * @returns {Decimal | null}
 */
export function normalizeMoneyToDecimal(v) {
  if (v == null || v === "") return null;
  try {
    const raw = String(v).trim().replace(",", ".");
    if (raw === "") return null;
    const d = new Decimal(raw);
    if (!d.isFinite() || d.lte(0)) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Inconsistências recuperáveis entre listing e promoção (não lançam).
 * @param {Decimal} listDec
 * @param {Decimal | null} promoDec
 * @returns {{ code: string; message: string }[]}
 */
export function validatePromotionListingConsistency(listDec, promoDec) {
  /** @type {{ code: string; message: string }[]} */
  const issues = [];
  if (promoDec == null) return issues;
  if (!promoDec.isFinite() || promoDec.lte(0)) {
    issues.push({
      code: PRICING_EVENT_CODE.INVALID_PROMOTION_NON_POSITIVE,
      message: "Preço promocional zero ou negativo — ignorado para promoção válida",
    });
    return issues;
  }
  if (promoDec.gte(listDec)) {
    issues.push({
      code: PRICING_EVENT_CODE.INVALID_PROMOTION_NOT_BELOW_LISTING,
      message: "Preço promocional >= preço de lista — não há promoção válida",
    });
  }
  return issues;
}

/**
 * @param {unknown} amount
 * @returns {{ ok: boolean; value: number | null }}
 */
export function guardPersistSaleFeeAmount(amount) {
  if (amount == null || amount === "") return { ok: true, value: null };
  let n;
  try {
    n = new Decimal(String(amount)).toNumber();
  } catch {
    return { ok: true, value: null };
  }
  if (!Number.isFinite(n)) return { ok: true, value: null };
  if (n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

const GROSS_VS_EXPECTED_TOLERANCE = new Decimal("0.12");

/**
 * Tarifa bruta na linha listing_prices vs esperado (% × base efetiva).
 * Ajuda a detectar preço de consulta errado ou respostas espúrias.
 *
 * @param {{
 *   marketplace?: string;
 *   listing_id: string | null;
 *   user_id?: string | null;
 *   sale_price_effective: number;
 *   fee_percent: number;
 *   gross_reference_from_row: number | null;
 *   context?: string;
 * }} opts
 */
export function maybeLogFeeGrossVsPercentBase(opts) {
  const gross = opts.gross_reference_from_row;
  if (gross == null || !Number.isFinite(gross) || gross <= 0) return;
  if (!Number.isFinite(opts.fee_percent) || opts.fee_percent <= 0) return;
  if (!Number.isFinite(opts.sale_price_effective) || opts.sale_price_effective <= 0) return;

  const expected = new Decimal(String(opts.sale_price_effective))
    .times(String(opts.fee_percent))
    .div(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const gr = new Decimal(String(gross)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (gr.minus(expected).abs().gt(GROSS_VS_EXPECTED_TOLERANCE)) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.FEE_BASE_MISMATCH, {
      marketplace: opts.marketplace ?? "mercado_livre",
      listing_id: opts.listing_id,
      user_id: opts.user_id ?? null,
      context: opts.context ?? "fee_gross_audit",
      sale_price_effective: String(opts.sale_price_effective),
      fee_percent: opts.fee_percent,
      expected_gross_from_percent_base: expected.toFixed(2),
      gross_fee_from_listing_prices_row: gr.toFixed(2),
      message:
        "Bruto de tarifa na linha listing_prices diverge de % × sale_price_effective — conferir preço da query ou resposta ML",
    });
  }
}
