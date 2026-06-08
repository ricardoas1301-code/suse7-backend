import Decimal from "decimal.js";
import { toFiniteNumber } from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import { extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails } from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";

/** @param {unknown} v */
function parseMlMoney(v) {
  return toFiniteNumber(v);
}

/** @param {Decimal} d */
function moneyDecimal(d) {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Rebate exibível no painel ML (“Descontos e bônus” / estorno de tarifa).
 * Não inclui desconto de preço do item, seller funding nem cupons genéricos da discounts API.
 *
 * @param {{
 *   feeGrossDec: Decimal | null;
 *   line?: Record<string, unknown> | null;
 *   qty?: number;
 *   saleFeeSubsidyDec?: Decimal | null;
 *   logContext?: {
 *     sale_id?: string | null;
 *     item_id?: string | null;
 *     external_order_id?: string | null;
 *   };
 * }} ctx
 * @returns {{
 *   marketplace_rebate: {
 *     source: "mercado_livre";
 *     label: "Descontos e bônus";
 *     amount_brl: string;
 *     raw_source_path: string;
 *     confidence: "explicit";
 *     is_estimated: false;
 *     updated_at: string;
 *   } | null;
 *   rebate_decision: "accepted" | "rejected";
 *   reject_reason: string | null;
 *   rebate_candidate_amount: string | null;
 *   rebate_candidate_source_path: string | null;
 * }}
 */
export function resolveMercadoLivreMarketplaceRebate(ctx) {
  const feeGrossDec = ctx.feeGrossDec;
  const line = ctx.line && typeof ctx.line === "object" ? ctx.line : null;
  const saleFeeSubsidyDec = ctx.saleFeeSubsidyDec ?? null;
  const logContext = ctx.logContext ?? {};

  const qty = ctx.qty != null && ctx.qty > 1 ? Math.trunc(ctx.qty) : 1;
  const lineSaleFeeRaw = line != null ? parseMlMoney(line.sale_fee ?? line.listing_fee) : null;
  const lineSaleFeeDec =
    lineSaleFeeRaw != null && lineSaleFeeRaw > 0
      ? qty > 1
        ? new Decimal(lineSaleFeeRaw).mul(qty)
        : new Decimal(lineSaleFeeRaw)
      : null;

  let candidateDec = null;
  /** @type {string | null} */
  let candidatePath = null;
  /** @type {string | null} */
  let rejectReason = null;

  if (feeGrossDec == null || feeGrossDec.lte(0)) {
    rejectReason = "missing_fee_gross";
  } else if (lineSaleFeeDec != null && feeGrossDec.minus(lineSaleFeeDec).abs().lt(0.01)) {
    rejectReason = "tariff_gross_equals_line_sale_fee_no_panel_rebate";
  } else if (lineSaleFeeDec != null && feeGrossDec.gt(lineSaleFeeDec)) {
    candidateDec = feeGrossDec.minus(lineSaleFeeDec);
    candidatePath = "explicit:marketplace_fee_gross_minus_line_sale_fee_net";
  } else if (line?.sale_fee_details) {
    const fromDetails = extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails(line.sale_fee_details);
    if (fromDetails != null && fromDetails > 0 && lineSaleFeeDec != null && feeGrossDec.gt(lineSaleFeeDec)) {
      const implied = feeGrossDec.minus(lineSaleFeeDec);
      if (Math.abs(fromDetails - implied) <= 0.05) {
        candidateDec = implied;
        candidatePath = "explicit:line.sale_fee_details.tariff_rebate";
      }
    }
  }

  if (
    candidateDec == null &&
    rejectReason == null &&
    saleFeeSubsidyDec != null &&
    saleFeeSubsidyDec.gt(0) &&
    lineSaleFeeDec != null &&
    feeGrossDec != null &&
    feeGrossDec.gt(lineSaleFeeDec)
  ) {
    const implied = feeGrossDec.minus(lineSaleFeeDec);
    if (saleFeeSubsidyDec.minus(implied).abs().lte(0.05)) {
      candidateDec = implied;
      candidatePath = "explicit:discounts.funding_mode_sale_fee_tariff_subsidy";
    }
  }

  if (candidateDec == null && rejectReason == null) {
    rejectReason = "no_explicit_tariff_rebate_source";
  }

  const netReceivedBefore =
    feeGrossDec != null && lineSaleFeeDec != null
      ? moneyDecimal(feeGrossDec) // placeholder for log; real net computed upstream
      : null;

  let marketplaceRebate = null;
  let rebateDecision = /** @type {"accepted" | "rejected"} */ ("rejected");

  if (candidateDec != null && candidateDec.gte(0.01) && rejectReason == null) {
    marketplaceRebate = {
      source: "mercado_livre",
      label: "Descontos e bônus",
      amount_brl: moneyDecimal(candidateDec),
      raw_source_path: candidatePath ?? "explicit:tariff_rebate",
      confidence: "explicit",
      is_estimated: false,
      updated_at: new Date().toISOString(),
    };
    rebateDecision = "accepted";
  }

  const shouldLog =
    process.env.S7_RAYX_REBATE_LOG === "1" ||
    logContext.sale_id != null ||
    logContext.item_id != null ||
    logContext.external_order_id != null;

  if (shouldLog) {
    console.log("[S7 RAYX REBATE RESOLVE]", {
      sale_id: logContext.sale_id ?? null,
      item_id: logContext.item_id ?? null,
      external_order_id: logContext.external_order_id ?? null,
      rebate_candidate_amount: candidateDec != null ? moneyDecimal(candidateDec) : null,
      rebate_candidate_source_path: candidatePath,
      rebate_decision: rebateDecision,
      reject_reason: marketplaceRebate ? null : rejectReason,
      fee_gross_brl: feeGrossDec != null ? moneyDecimal(feeGrossDec) : null,
      line_sale_fee_brl: lineSaleFeeDec != null ? moneyDecimal(lineSaleFeeDec) : null,
      qty,
      net_received_before: netReceivedBefore,
      net_received_after: marketplaceRebate?.amount_brl ?? null,
    });
  }

  return {
    marketplace_rebate: marketplaceRebate,
    rebate_decision: rebateDecision,
    reject_reason: marketplaceRebate ? null : rejectReason,
    rebate_candidate_amount: candidateDec != null ? moneyDecimal(candidateDec) : null,
    rebate_candidate_source_path: candidatePath,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} fin
 */
export function marketplaceRebateFromFinancialSnapshot(fin) {
  if (!fin || typeof fin !== "object") return null;
  const nested =
    fin.marketplace_rebate && typeof fin.marketplace_rebate === "object"
      ? /** @type {Record<string, unknown>} */ (fin.marketplace_rebate)
      : null;
  if (nested?.confidence === "explicit" && nested.amount_brl != null && String(nested.amount_brl).trim() !== "") {
    return nested;
  }
  return null;
}
