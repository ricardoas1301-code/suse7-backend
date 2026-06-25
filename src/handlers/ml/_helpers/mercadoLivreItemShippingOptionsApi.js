// ======================================================
// Mercado Livre — GET /items/:item_id/shipping_options
// Fonte premium para frete por CENÁRIO: zip de referência + price do cenário.
// Documentação: developers.mercadolibre — Calculate shipping costs (item + zip_code).
// ======================================================

import {
  logPricingEvent,
  PRICING_LOG_LEVEL,
  PRICING_EVENT_CODE,
} from "../../../domain/pricing/pricingInconsistencyLog.js";
import {
  escolherCandidatoFreteSellerOficialMl,
  gerarCandidatosFreteSellerMl,
} from "../../../domain/pricing/mercadoLivreOfficialShippingCandidate.js";
import Decimal from "decimal.js";

const ML_API = "https://api.mercadolibre.com";
const ROUND = Decimal.ROUND_HALF_UP;

/** @param {unknown} v @returns {Decimal | null} */
function dMoney(v) {
  if (v == null || v === "") return null;
  try {
    const x = new Decimal(String(v).replace(",", "."));
    return x.isFinite() ? x : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d @returns {string | null} */
function decStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * @param {string} accessToken
 * @param {string} itemId — MLB…
 * @param {{
 *   zipCode: string;
 *   priceBrl?: string | null;
 *   scenario_type?: string | null;
 *   diagnostics?: {
 *     shipping_logistic_type?: string | null;
 *     listing_status?: string | null;
 *     available_quantity?: number | null;
 *     marketplace_account_id?: string | null;
 *     seller_id?: string | null;
 *   } | null;
 * }} p
 * @returns {Promise<{ ok: boolean; http_status: number; json: Record<string, unknown> | null; error?: string }>}
 */
export async function fetchMercadoLivreItemShippingOptions(accessToken, itemId, p) {
  const zip = p.zipCode != null ? String(p.zipCode).trim() : "";
  const id = itemId != null ? String(itemId).trim() : "";
  if (!accessToken || !id || !zip) {
    return { ok: false, http_status: 0, json: null, error: "missing_token_item_or_zip" };
  }

  const params = new URLSearchParams();
  params.set("zip_code", zip);
  if (p.priceBrl != null && String(p.priceBrl).trim() !== "") {
    params.set("price", String(p.priceBrl).trim());
  }

  const url = `${ML_API}/items/${encodeURIComponent(id)}/shipping_options?${params.toString()}`;
  const tokenTail =
    accessToken && accessToken.length >= 8 ? accessToken.slice(-8) : accessToken ? accessToken : null;
  const diag = p.diagnostics && typeof p.diagnostics === "object" ? p.diagnostics : null;
  const listingStatus =
    diag?.listing_status != null && String(diag.listing_status).trim() !== ""
      ? String(diag.listing_status).trim()
      : null;
  const logisticType =
    diag?.shipping_logistic_type != null && String(diag.shipping_logistic_type).trim() !== ""
      ? String(diag.shipping_logistic_type).trim()
      : null;
  const accountId =
    diag?.marketplace_account_id != null && String(diag.marketplace_account_id).trim() !== ""
      ? String(diag.marketplace_account_id).trim()
      : null;
  const sellerId =
    diag?.seller_id != null && String(diag.seller_id).trim() !== ""
      ? String(diag.seller_id).trim()
      : null;

  logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SHIPPING_OPTIONS_FETCH_START, {
    marketplace: "mercado_livre",
    item_id: id,
    listing_id: id,
    scenario_type: p.scenario_type ?? null,
    zip_code: zip,
    sale_price_brl: p.priceBrl ?? null,
    request_url: url,
    request_query: {
      zip_code: zip,
      price: p.priceBrl ?? null,
    },
    shipping_logistic_type: logisticType,
    listing_status: listingStatus,
    available_quantity: diag?.available_quantity ?? null,
    marketplace_account_id: accountId,
    seller_id: sellerId,
    access_token_tail: tokenTail,
    source_endpoint: "/items/{id}/shipping_options",
  });

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const raw = await res.text();
    /** @type {Record<string, unknown> | null} */
    let json = null;
    try {
      json = raw ? /** @type {Record<string, unknown>} */ (JSON.parse(raw)) : null;
    } catch {
      json = null;
    }

    if (!res.ok || !json || typeof json !== "object" || Array.isArray(json)) {
      const errCode =
        json && typeof json === "object" && "error" in json ? String(json.error ?? "") || null : null;
      const errMsg =
        json && typeof json === "object" && "message" in json ? String(json.message ?? "") || null : null;
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_SHIPPING_OPTIONS_FETCH_FAIL, {
        marketplace: "mercado_livre",
        item_id: id,
        listing_id: id,
        source_endpoint: "/items/{id}/shipping_options",
        request_url: url,
        request_query: {
          zip_code: zip,
          price: p.priceBrl ?? null,
        },
        shipping_logistic_type: logisticType,
        listing_status: listingStatus,
        available_quantity: diag?.available_quantity ?? null,
        marketplace_account_id: accountId,
        seller_id: sellerId,
        access_token_tail: tokenTail,
        http_status: res.status,
        sale_price_brl: p.priceBrl ?? null,
        ml_error_code: errCode,
        ml_error_message: errMsg,
        body_preview: raw?.slice?.(0, 400) ?? null,
      });
      return { ok: false, http_status: res.status, json: null, error: `http_${res.status}` };
    }

    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SHIPPING_OPTIONS_FETCH_OK, {
      marketplace: "mercado_livre",
      item_id: id,
      listing_id: id,
      http_status: res.status,
      sale_price_brl: p.priceBrl ?? null,
      has_options: Array.isArray(json.options) && json.options.length > 0,
    });

    return { ok: true, http_status: res.status, json };
  } catch (e) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_SHIPPING_OPTIONS_FETCH_FAIL, {
      marketplace: "mercado_livre",
      item_id: id,
      listing_id: id,
      source_endpoint: "/items/{id}/shipping_options",
      request_url: url,
      request_query: {
        zip_code: zip,
        price: p.priceBrl ?? null,
      },
      shipping_logistic_type: logisticType,
      listing_status: listingStatus,
      available_quantity: diag?.available_quantity ?? null,
      marketplace_account_id: accountId,
      seller_id: sellerId,
      access_token_tail: tokenTail,
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      http_status: 0,
      json: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Extrai campos brutos da opção recomendada de shipping_options (auditoria ML).
 * @param {Record<string, unknown> | null} json
 */
export function extrairCamposBrutosShippingOptionsMl(json) {
  if (!json || typeof json !== "object") return null;
  const opts = json.options;
  if (!Array.isArray(opts) || opts.length === 0) return null;
  const optRaw =
    /** @type {Record<string, unknown> | undefined} */ (
      opts.find((o) => o && typeof o === "object" && /** @type {Record<string, unknown>} */ (o).display === "recommended")
    ) ?? (opts[0] && typeof opts[0] === "object" ? /** @type {Record<string, unknown>} */ (opts[0]) : undefined);
  if (!optRaw || typeof optRaw !== "object") return null;

  const listCost = dMoney(optRaw.list_cost);
  const buyerCost = dMoney(optRaw.cost);
  const baseCost = dMoney(optRaw.base_cost);
  const disc =
    optRaw.discount && typeof optRaw.discount === "object"
      ? /** @type {Record<string, unknown>} */ (optRaw.discount)
      : null;
  const promoted = disc ? dMoney(disc.promoted_amount) : null;

  return {
    option_id: optRaw.id != null ? optRaw.id : null,
    list_cost: listCost != null ? decStr2(listCost) : null,
    buyer_cost: buyerCost != null ? decStr2(buyerCost) : null,
    base_cost: baseCost != null ? decStr2(baseCost) : null,
    promoted_amount: promoted != null ? decStr2(promoted) : null,
    listCost,
    buyerCost,
    baseCost,
    promoted,
    optRaw,
  };
}

/**
 * Extrai custo de envio **para o seller**, subsídio logístico ML e contexto do comprador.
 * Escolhe candidato alinhado ao payout/logística oficial quando informados.
 *
 * @param {Record<string, unknown> | null} json — resposta GET shipping_options
 * @param {Record<string, unknown> | null | undefined} listing — item ML (free_shipping, etc.)
 * @param {{
 *   salePriceDec?: Decimal | null;
 *   feeAmountDec?: Decimal | null;
 *   listingPricesLogisticsDec?: Decimal | null;
 *   listingPricesPayoutDec?: Decimal | null;
 * }} [opts]
 * @returns {{
 *   seller_shipping_cost_brl: string | null;
 *   seller_shipping_cost_source: string | null;
 *   shipping_subsidy_amount_brl: string | null;
 *   shipping_context: "buyer_pays" | "free_for_buyer";
 *   option_id: string | number | null;
 *   pick_reason?: string | null;
 *   raw_fields?: Record<string, unknown> | null;
 * } | null}
 */
export function parseMercadoLivreItemShippingOptionsForScenario(json, listing, opts = {}) {
  const bruto = extrairCamposBrutosShippingOptionsMl(json);
  if (bruto == null) return null;

  const { listCost, buyerCost, promoted, optRaw } = bruto;
  const candidates = gerarCandidatosFreteSellerMl({ listCost, buyerCost, promoted });
  const picked = escolherCandidatoFreteSellerOficialMl({
    candidates,
    salePriceDec: opts.salePriceDec ?? null,
    feeAmountDec: opts.feeAmountDec ?? null,
    listingPricesLogisticsDec: opts.listingPricesLogisticsDec ?? null,
    listingPricesPayoutDec: opts.listingPricesPayoutDec ?? null,
  });

  let sellerPay = picked?.amount ?? null;
  let sellerPaySource = picked?.source ?? "unresolved";

  if ((sellerPay == null || sellerPay.lte(0)) && bruto.baseCost != null && bruto.baseCost.gte(0)) {
    sellerPay = bruto.baseCost;
    sellerPaySource = "base_cost";
  }
  if (sellerPay != null && sellerPay.lt(0)) sellerPay = new Decimal(0);

  /** Comprador: cost === 0 → grátis para o comprador (frete exibido ao buyer). */
  let shipping_context = picked?.context ?? /** @type {"buyer_pays" | "free_for_buyer"} */ ("buyer_pays");
  if (buyerCost != null && buyerCost.isZero()) {
    shipping_context = "free_for_buyer";
  } else if (buyerCost != null && buyerCost.gt(0)) {
    shipping_context = "buyer_pays";
  } else {
    const sh = listing?.shipping && typeof listing.shipping === "object" ? listing.shipping : null;
    if (sh?.free_shipping === true && (buyerCost == null || buyerCost.isZero())) {
      shipping_context = "free_for_buyer";
    }
  }

  const subsidyStr =
    promoted != null && promoted.gt(0) ? decStr2(promoted) : null;

  return {
    seller_shipping_cost_brl: sellerPay != null ? decStr2(sellerPay) : null,
    seller_shipping_cost_source: sellerPaySource,
    shipping_subsidy_amount_brl: subsidyStr,
    shipping_context,
    option_id: optRaw.id != null ? optRaw.id : null,
    pick_reason: picked?.pick_reason ?? null,
    raw_fields: {
      list_cost: bruto.list_cost,
      buyer_cost: bruto.buyer_cost,
      base_cost: bruto.base_cost,
      promoted_amount: bruto.promoted_amount,
      candidates: candidates.map((c) => ({
        amount_brl: decStr2(c.amount),
        source: c.source,
        context: c.context,
      })),
    },
  };
}
