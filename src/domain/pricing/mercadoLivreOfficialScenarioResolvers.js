// ======================================================
// Resolvers oficiais ML por sale_price — tarifa (listing_prices) e helpers compartilhados.
// Fonte única para Raio-X, Precificação Inteligente e solver margem→preço.
// Sem hardcode; Decimal/string para dinheiro.
//
/**
 * ENGINE FINANCEIRA HOMOLOGADA
 *
 * Alterações exigem:
 * - Nova trilha
 * - Nova homologação
 * - Comparação com simulador oficial ML
 *
 * Não alterar sem aprovação explícita.
 * Doc: docs/precificacao/PI_ENGINE_HOMOLOGADA.md
 */
// ======================================================

import Decimal from "decimal.js";

import { enrichItemWithListingPricesFees, escolherLinhaListingPricesParaTarifa, listingPricesArrayFromResponseJson } from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { logPricingEvent, PRICING_EVENT_CODE, PRICING_LOG_LEVEL } from "./pricingInconsistencyLog.js";
import { logPricingLowPriceFeeDebug } from "./pricingFlowDiffLog.js";

const ROUND = Decimal.ROUND_HALF_UP;

/**
 * @param {unknown} v
 * @returns {Decimal | null}
 */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} listing
 * @param {string} externalListingId
 */
function resolverContextoItemMl(listing, externalListingId) {
  const raw =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : {};

  const extId =
    externalListingId ||
    (listing.external_listing_id != null ? String(listing.external_listing_id).trim() : "");
  let siteId = "";
  const siteFromRaw = raw.site_id != null ? String(raw.site_id).trim() : "";
  if (siteFromRaw) {
    siteId = siteFromRaw;
  } else if (extId) {
    const m = extId.match(/^([A-Z]{3})\d/i);
    if (m) siteId = m[1].toUpperCase();
  }

  const categoryId =
    raw.category_id != null && String(raw.category_id).trim() !== ""
      ? String(raw.category_id).trim()
      : listing.category_id != null && String(listing.category_id).trim() !== ""
        ? String(listing.category_id).trim()
        : null;
  const currencyId =
    listing.currency_id != null && String(listing.currency_id).trim() !== ""
      ? String(listing.currency_id).trim()
      : raw.currency_id != null && String(raw.currency_id).trim() !== ""
        ? String(raw.currency_id).trim()
        : "BRL";
  const shipping =
    raw.shipping != null && typeof raw.shipping === "object"
      ? /** @type {Record<string, unknown>} */ (raw.shipping)
      : listing.shipping != null && typeof listing.shipping === "object"
        ? /** @type {Record<string, unknown>} */ (listing.shipping)
        : null;
  const listingTypeId =
    listing.listing_type_id != null && String(listing.listing_type_id).trim() !== ""
      ? String(listing.listing_type_id).trim()
      : raw.listing_type_id != null && String(raw.listing_type_id).trim() !== ""
        ? String(raw.listing_type_id).trim()
        : null;

  return { extId, siteId, categoryId, currencyId, shipping, listingTypeId };
}

/**
 * seller_id numérico do vendedor ML (shipping_options/free exige users/{id}/…).
 * @param {Record<string, unknown>} listing
 */
export function resolverSellerIdMercadoLivre(listing) {
  if (listing.seller_id != null && String(listing.seller_id).trim() !== "") {
    return String(listing.seller_id).trim();
  }
  const raw =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;
  if (raw?.seller_id != null && String(raw.seller_id).trim() !== "") {
    return String(raw.seller_id).trim();
  }
  const sellerObj =
    raw?.seller != null && typeof raw.seller === "object"
      ? /** @type {Record<string, unknown>} */ (raw.seller)
      : null;
  if (sellerObj?.id != null && String(sellerObj.id).trim() !== "") {
    return String(sellerObj.id).trim();
  }
  if (listing.external_seller_id != null && String(listing.external_seller_id).trim() !== "") {
    return String(listing.external_seller_id).trim();
  }
  if (listing.ml_user_id != null && String(listing.ml_user_id).trim() !== "") {
    return String(listing.ml_user_id).trim();
  }
  return null;
}

/**
 * Item ML “limpo” para consulta listing_prices/shipping no preço simulado.
 * Não herda original_price/base_price do listing persistido (evita consultar 299,90 ao simular 109).
 * @param {Record<string, unknown>} listing
 * @param {Decimal} priceDec
 * @param {{ externalListingId?: string | null; listingTypeId?: string | null }} [p]
 */
export function montarItemMlSinteticoPorPreco(listing, priceDec, p = {}) {
  const ctx = resolverContextoItemMl(
    listing,
    p.externalListingId != null ? String(p.externalListingId).trim() : "",
  );
  const tipo =
    p.listingTypeId != null && String(p.listingTypeId).trim() !== ""
      ? String(p.listingTypeId).trim()
      : ctx.listingTypeId;
  const sellerId = resolverSellerIdMercadoLivre(listing);
  return {
    id: ctx.extId || null,
    site_id: ctx.siteId,
    price: priceDec.toDecimalPlaces(2, ROUND).toNumber(),
    listing_type_id: tipo,
    category_id: ctx.categoryId,
    currency_id: ctx.currencyId,
    ...(sellerId != null ? { seller_id: sellerId } : {}),
    ...(ctx.shipping != null ? { shipping: ctx.shipping } : {}),
  };
}

/**
 * Snapshot listing_prices coerente com o sale_price do cenário (rejeita payout de catálogo stale).
 * @param {string} priceStr
 * @param {string | null} payoutBrl
 */
export function snapshotListingPricesCoerenteComPreco(priceStr, payoutBrl) {
  if (payoutBrl == null || String(payoutBrl).trim() === "") return true;
  try {
    const sale = new Decimal(String(priceStr).trim());
    const pay = new Decimal(String(payoutBrl).trim());
    if (!sale.isFinite() || !pay.isFinite() || sale.lte(0)) return false;
    return pay.lte(sale.plus("0.02"));
  } catch {
    return false;
  }
}

/**
 * Extrai tarifa (% e R$) de uma linha listing_prices + item sintético (derive %×preço quando necessário).
 * @param {Record<string, unknown> | null | undefined} row
 * @param {Record<string, unknown>} itemSintetico
 * @param {Decimal} priceDec
 * @returns {Promise<{
 *   feeAmtNum: number | null;
 *   feePctNum: number | null;
 *   parser_result: Record<string, unknown>;
 *   parser_rejection_reason: string | null;
 * }>}
 */
async function extrairTarifaOficialDeLinhaListingPrices(row, itemSintetico, priceDec) {
  const { extractOfficialMercadoLibreListingPricesFee, extractSaleFee } = await import(
    "../../handlers/ml/_helpers/mlItemMoneyExtract.js"
  );
  if (!row || typeof row !== "object") {
    return {
      feeAmtNum: null,
      feePctNum: null,
      parser_result: { official: null, derived: null },
      parser_rejection_reason: "missing_listing_prices_row",
    };
  }
  const rowRec = /** @type {Record<string, unknown>} */ (row);
  const officialFromRow = extractOfficialMercadoLibreListingPricesFee(rowRec);
  let feeAmtNum =
    officialFromRow.amount != null && officialFromRow.amount > 0 ? officialFromRow.amount : null;
  let feePctNum =
    officialFromRow.percent != null && officialFromRow.percent > 0 ? officialFromRow.percent : null;

  const derived = extractSaleFee(
    {
      ...itemSintetico,
      sale_fee_amount: rowRec.sale_fee_amount ?? rowRec.selling_fee ?? rowRec.sale_fee,
      sale_fee_percent: rowRec.sale_fee_percent,
      sale_fee_details: rowRec.sale_fee_details,
    },
    {
      deriveFromPercent: true,
      listing: itemSintetico,
      skipDeepExtract: false,
    },
  );

  if (feeAmtNum == null || !(feeAmtNum > 0)) {
    if (derived.amount != null && derived.amount > 0) feeAmtNum = derived.amount;
  }
  if ((feePctNum == null || !(feePctNum > 0)) && derived.percent != null && derived.percent > 0) {
    feePctNum = derived.percent;
  }
  if ((feeAmtNum == null || !(feeAmtNum > 0)) && feePctNum != null && feePctNum > 0 && priceDec.gt(0)) {
    feeAmtNum = priceDec.mul(feePctNum).div(100).toDecimalPlaces(2, ROUND).toNumber();
  }

  /** @type {string | null} */
  let parser_rejection_reason = null;
  if (feeAmtNum == null && feePctNum == null) {
    if (rowRec.sale_fee_details == null && rowRec.sale_fee_amount == null && rowRec.selling_fee == null) {
      parser_rejection_reason = "row_without_fee_fields";
    } else if (derived.amount == null && derived.percent == null) {
      parser_rejection_reason = "parser_no_amount_or_percent";
    } else {
      parser_rejection_reason = "fee_non_positive_after_parse";
    }
  }

  return {
    feeAmtNum: feeAmtNum != null && feeAmtNum > 0 ? feeAmtNum : null,
    feePctNum: feePctNum != null && feePctNum > 0 ? feePctNum : null,
    parser_result: {
      official: officialFromRow,
      derived,
      row_listing_type_id: rowRec.listing_type_id ?? rowRec.mapping ?? rowRec.listing_type ?? null,
      sale_fee_amount: rowRec.sale_fee_amount ?? null,
      sale_fee_percent: rowRec.sale_fee_percent ?? null,
      has_sale_fee_details: rowRec.sale_fee_details != null,
    },
    parser_rejection_reason,
  };
}

/**
 * Re-parse do corpo HTTP bruto quando enrich não escolheu linha utilizável.
 * @param {Record<string, unknown> | null | undefined} httpRaw
 * @param {Record<string, unknown>} itemSintetico
 * @param {Decimal} priceDec
 */
async function extrairTarifaOficialDoCorpoListingPricesHttp(httpRaw, itemSintetico, priceDec) {
  const body = httpRaw?.response_body ?? null;
  const arr = listingPricesArrayFromResponseJson(body);
  if (arr.length === 0) {
    return {
      row: null,
      feeAmtNum: null,
      feePctNum: null,
      parser_result: { rows_count: 0 },
      parser_rejection_reason: "empty_response_rows",
    };
  }
  const row = escolherLinhaListingPricesParaTarifa(itemSintetico, arr);
  const parsed = await extrairTarifaOficialDeLinhaListingPrices(row, itemSintetico, priceDec);
  return { row, ...parsed };
}

/**
 * Tarifa oficial (% e R$) via GET listing_prices para o preço do cenário.
 * @param {{
 *   accessToken: string | null | undefined;
 *   listing: Record<string, unknown>;
 *   externalListingId?: string | null;
 *   listingTypeId?: string | null;
 *   priceDec: Decimal;
 *   listingUuid?: string | null;
 *   scenarioType?: string | null;
 * }} p
 * @returns {Promise<{ amount_brl: string | null; percent: string | null; source: string; raw_reference?: string | null } | null>}
 */
export async function resolverTarifaOficialMercadoLivrePorPreco(p) {
  const { accessToken, listing, priceDec, listingUuid, scenarioType } = p;
  if (!accessToken || priceDec == null || !priceDec.isFinite() || priceDec.lte(0)) {
    return null;
  }

  const { extId, siteId, categoryId, currencyId, shipping, listingTypeId } = resolverContextoItemMl(
    listing,
    p.externalListingId != null ? String(p.externalListingId).trim() : "",
  );
  const tipo =
    p.listingTypeId != null && String(p.listingTypeId).trim() !== ""
      ? String(p.listingTypeId).trim()
      : listingTypeId;
  if (!siteId || !tipo) {
    console.info("[ml-official-fee-resolver] skipped", {
      listing_id: listingUuid ?? null,
      sale_price: decToStr2(priceDec),
      reason: !siteId ? "missing_site_id" : "missing_listing_type_id",
    });
    return null;
  }

  const itemSintetico = montarItemMlSinteticoPorPreco(listing, priceDec, {
    externalListingId: p.externalListingId != null ? String(p.externalListingId).trim() : "",
    listingTypeId: p.listingTypeId,
  });

  try {
    const enriched = await enrichItemWithListingPricesFees(accessToken, itemSintetico, {
      healthSync: false,
      preservarPrecoCenarioSimulacao: true,
    });
    const rec = enriched && typeof enriched === "object" ? /** @type {Record<string, unknown>} */ (enriched) : {};
    const rowPersist =
      rec._suse7_listing_prices_row_persist != null && typeof rec._suse7_listing_prices_row_persist === "object"
        ? /** @type {Record<string, unknown>} */ (rec._suse7_listing_prices_row_persist)
        : rec;

    const httpRaw =
      rec._suse7_listing_prices_http_raw != null && typeof rec._suse7_listing_prices_http_raw === "object"
        ? /** @type {Record<string, unknown>} */ (rec._suse7_listing_prices_http_raw)
        : null;

    console.info("[ml-fee-raw]", {
      endpoint: "GET /sites/{site_id}/listing_prices",
      listing_id: listingUuid ?? null,
      external_listing_id: extId || null,
      scenario_type: scenarioType ?? null,
      sale_price: decToStr2(priceDec),
      price_sent: itemSintetico.price ?? null,
      category_id: itemSintetico.category_id ?? null,
      listing_type_id: tipo,
      request_url: httpRaw?.request_url ?? null,
      response_status: httpRaw?.http_status ?? null,
      sale_fee_amount: rowPersist.sale_fee_amount ?? rec.sale_fee_amount ?? null,
      sale_fee_percent: rowPersist.sale_fee_percent ?? rec.sale_fee_percent ?? null,
      selling_fee: rowPersist.selling_fee ?? rec.selling_fee ?? null,
      has_sale_fee_details: rowPersist.sale_fee_details != null || rec.sale_fee_details != null,
    });

    let rowParaTarifa =
      rowPersist && typeof rowPersist === "object" ? /** @type {Record<string, unknown>} */ (rowPersist) : null;
    let parsed = await extrairTarifaOficialDeLinhaListingPrices(rowParaTarifa, itemSintetico, priceDec);

    if ((parsed.feeAmtNum == null || !(parsed.feeAmtNum > 0)) && httpRaw?.response_body != null) {
      const fallback = await extrairTarifaOficialDoCorpoListingPricesHttp(httpRaw, itemSintetico, priceDec);
      if (fallback.feeAmtNum != null && fallback.feeAmtNum > 0) {
        rowParaTarifa =
          fallback.row && typeof fallback.row === "object"
            ? /** @type {Record<string, unknown>} */ (fallback.row)
            : rowParaTarifa;
        parsed = {
          feeAmtNum: fallback.feeAmtNum,
          feePctNum: fallback.feePctNum,
          parser_result: {
            .../** @type {Record<string, unknown>} */ (parsed.parser_result),
            fallback_from_http_body: fallback.parser_result,
          },
          parser_rejection_reason: null,
        };
      } else if (parsed.parser_rejection_reason == null) {
        parsed.parser_rejection_reason = fallback.parser_rejection_reason;
      }
    }

    let feeAmtNum = parsed.feeAmtNum;
    let feePctNum = parsed.feePctNum;

    const amountDec =
      feeAmtNum != null && feeAmtNum > 0 ? new Decimal(feeAmtNum).toDecimalPlaces(2, ROUND) : null;
    let feeAmount = amountDec != null ? amountDec.toFixed(2) : null;
    let feePercent = formatarPercentualTarifaComercial(
      feePctNum != null && feePctNum > 0 ? String(feePctNum) : null,
      amountDec,
      priceDec,
    );
    if (feePercent == null && feeAmount != null && priceDec.gt(0)) {
      feePercent = formatarPercentualTarifaComercial(null, amountDec, priceDec);
    }
    if (feeAmount == null && feePercent != null && priceDec.gt(0)) {
      feeAmount = priceDec.mul(feePercent).div(100).toDecimalPlaces(2, ROUND).toFixed(2);
    }

    const rowPersistRef =
      rowParaTarifa ??
      (rowPersist && typeof rowPersist === "object" ? /** @type {Record<string, unknown>} */ (rowPersist) : null);

    if (priceDec.lte(200)) {
      logPricingLowPriceFeeDebug({
        listing_id: listingUuid ?? extId ?? null,
        sale_price: decToStr2(priceDec),
        listing_type_id: tipo,
        request_url: httpRaw?.request_url ?? null,
        http_status: httpRaw?.http_status ?? null,
        response_body: httpRaw?.response_body ?? null,
        sale_fee_amount: rowPersistRef?.sale_fee_amount ?? null,
        sale_fee_percent: rowPersistRef?.sale_fee_percent ?? null,
        parser_result: parsed.parser_result,
        parser_rejection_reason: parsed.parser_rejection_reason,
        final_fee_amount: feeAmount,
        final_fee_percent: feePercent,
      });
    }

    if (feePercent == null && feeAmount == null) {
      console.info("[ml-official-fee-resolver] no_fee", {
        listing_id: listingUuid ?? null,
        sale_price: decToStr2(priceDec),
        listing_type_id: tipo,
        request_url: httpRaw?.request_url ?? null,
        response_status: httpRaw?.http_status ?? null,
        price_sent: itemSintetico.price ?? null,
      });
      return {
        amount_brl: null,
        percent: null,
        source: "ml_listing_prices_no_fee",
        debug: {
          endpoint: "GET /sites/{site_id}/listing_prices",
          request_url: httpRaw?.request_url ?? null,
          response_status: httpRaw?.http_status ?? null,
          price_sent: decToStr2(priceDec),
          category_id: itemSintetico.category_id ?? null,
          listing_type_id: tipo,
        },
      };
    }

    const rowPersistRefFinal =
      rowParaTarifa ??
      (rec._suse7_listing_prices_row_persist != null && typeof rec._suse7_listing_prices_row_persist === "object"
        ? /** @type {Record<string, unknown>} */ (rec._suse7_listing_prices_row_persist)
        : rec);
    const rawRef =
      rowPersistRefFinal.sale_fee_amount != null
        ? String(rowPersistRefFinal.sale_fee_amount)
        : rowPersistRefFinal.sale_fee_details != null
          ? "sale_fee_details"
          : null;

    console.info("[ml-official-fee-resolver]", {
      listing_id: listingUuid ?? null,
      external_listing_id: extId || null,
      scenario_type: scenarioType ?? null,
      sale_price: decToStr2(priceDec),
      source: "ml_listing_prices",
      fee_amount_brl: feeAmount,
      fee_percent: feePercent,
      raw_reference: rawRef,
    });

    return {
      amount_brl: feeAmount,
      percent: feePercent,
      source: "ml_listing_prices",
      raw_reference: rawRef,
      debug: {
        endpoint: "GET /sites/{site_id}/listing_prices",
        request_url: httpRaw?.request_url ?? null,
        response_status: httpRaw?.http_status ?? null,
        price_sent: decToStr2(priceDec),
        category_id: itemSintetico.category_id ?? null,
        listing_type_id: tipo,
      },
    };
  } catch (e) {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.PRICING_FALLBACK_APPLIED, {
      marketplace: "mercado_livre",
      listing_id: listingUuid ?? null,
      external_listing_id: extId || null,
      context: "official_fee_resolver",
      sale_price_brl: decToStr2(priceDec),
      reason: "listing_prices_fetch_failed",
      message: e instanceof Error ? e.message : String(e),
    });
    console.info("[ml-official-fee-resolver] error", {
      listing_id: listingUuid ?? null,
      sale_price: decToStr2(priceDec),
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** @param {Decimal | null} d */
function decToStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * Percentual comercial para exibição — prioriza ML; inferência com snap a 0,05 p.p. quando próximo.
 * @param {string | null | undefined} percentOficial
 * @param {Decimal | null} amountDec
 * @param {Decimal | null} priceDec
 */
function formatarPercentualTarifaComercial(percentOficial, amountDec, priceDec) {
  if (percentOficial != null && String(percentOficial).trim() !== "") {
    const d = toDec(String(percentOficial).trim());
    if (d != null && d.isFinite() && d.gt(0)) {
      return d.toDecimalPlaces(2, ROUND).toFixed(2);
    }
  }
  if (amountDec != null && priceDec != null && priceDec.gt(0)) {
    const inferred = amountDec.div(priceDec).mul(100);
    const snapped = inferred.toNearest(0.05, ROUND);
    if (inferred.minus(snapped).abs().lte(new Decimal("0.02"))) {
      return snapped.toDecimalPlaces(2, ROUND).toFixed(2);
    }
    return inferred.toDecimalPlaces(2, ROUND).toFixed(2);
  }
  return null;
}

/**
 * Indica se devemos resolver frete via shipping_options?price= (oficial por preço).
 * @param {{
 *   mlAccessToken?: string | null;
 *   itemMlId?: string | null;
 *   referenceZipCode?: string | null;
 * }} p
 */
export function deveUsarFreteOficialMercadoLivrePorPreco(p) {
  const token = p.mlAccessToken != null && String(p.mlAccessToken).trim() !== "";
  const item = p.itemMlId != null && String(p.itemMlId).trim() !== "";
  const zip = p.referenceZipCode != null && String(p.referenceZipCode).trim() !== "";
  return token && item && zip;
}
