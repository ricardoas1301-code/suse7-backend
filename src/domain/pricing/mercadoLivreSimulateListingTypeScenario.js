// ======================================================
// Simulação oficial de cenário por tipo de anúncio (Precificação Inteligente).
//
// Usa a MESMA engine do Raio-X: computeMercadoLivreScenarioComoRayxParaPI
// (paridade de parâmetros com buildMercadoLivreListingPricingScenariosPayload).
// Sem resolver paralelo de comissão / pricingIntelligenceSimulate.
// ======================================================

import Decimal from "decimal.js";

import {
  loadMercadoLivreListingPricingInputs,
  loadMercadoLivreListingPricingInputsByExternalId,
} from "../../handlers/pricing/_helpers/mercadoLivrePricingSimulation.js";
import { computeMercadoLivreScenarioComoRayxParaPI } from "./mercadoLivreListingPricingScenarios.js";
import {
  aplicarExtrasPrecificacaoInteligente,
  temExtrasPrecificacaoInteligenteAtivos,
} from "./aplicarExtrasPrecificacaoInteligente.js";
import { extrairMetricasFluxoPrecificacao, logPricingFlowDiff } from "./pricingFlowDiffLog.js";

const ROUND = Decimal.ROUND_HALF_UP;

/** @typedef {"classic" | "premium"} ListingTypeChoice */

/** Tipo de anúncio → listing_type_id oficial do Mercado Livre. */
function listingTypeIdParaTipo(/** @type {ListingTypeChoice} */ tipo) {
  return tipo === "premium" ? "gold_pro" : "gold_special";
}

/** @param {unknown} v */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d */
function decToStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * Simula UM cenário oficial (tipo + preço) via engine Raio-X.
 * @param {{
 *   inputs: { listing: Record<string, unknown>; health: Record<string, unknown> | null; metrics: Record<string, unknown> | null; sellerTaxPct: string | null; external_listing_id: string };
 *   listingType: ListingTypeChoice;
 *   priceDec: Decimal;
 *   mlAccessToken: string | null;
 *   referenceZipCode: string | null;
 *   listingUuid: string | null;
 * }} p
 */
async function simularCenarioOficialUnico(p) {
  const { inputs, listingType, priceDec, mlAccessToken, referenceZipCode, listingUuid } = p;
  const listingTypeId = listingTypeIdParaTipo(listingType);
  const externalListingId = inputs.external_listing_id || "";
  const salePriceStr = priceDec.toDecimalPlaces(2, ROUND).toFixed(2);

  const { scenario, engine_path } = await computeMercadoLivreScenarioComoRayxParaPI({
    listing: inputs.listing,
    health: inputs.health,
    metrics: inputs.metrics,
    sellerTaxPct: inputs.sellerTaxPct,
    salePriceStr,
    listingTypeId,
    mlAccessToken,
    referenceZipCode,
    itemMlId: externalListingId,
    listingUuid,
  });

  const m = extrairMetricasFluxoPrecificacao(scenario);
  logPricingFlowDiff({
    flow: "pi",
    handler: "POST /api/ml/listings/pricing-simulate-scenario",
    listingExternalId: externalListingId || null,
    sale_price: salePriceStr,
    listing_type: listingTypeId,
    has_marketplace_account: Boolean(mlAccessToken),
    has_access_token: Boolean(mlAccessToken),
    token_source: mlAccessToken ? "getValidMLToken" : null,
    calls_listing_prices: Boolean(mlAccessToken && externalListingId),
    listing_prices_status: m.fee_amount_brl != null ? "resolved" : "unresolved",
    fee_amount_brl: m.fee_amount_brl,
    fee_source: m.fee_source,
    shipping_cost_brl: m.shipping_cost_brl,
    shipping_source: m.shipping_source,
    payout_brl: m.payout_brl,
    warnings: m.warnings,
    engine_path,
  });

  const mk =
    scenario.marketplace != null && typeof scenario.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.marketplace)
      : {};

  return {
    listing_type: listingType,
    listing_type_id: listingTypeId,
    commission_source: scenario.official_fee_source != null ? String(scenario.official_fee_source) : "rayx_engine",
    official_fee_percent:
      mk.sale_fee_percent != null ? String(mk.sale_fee_percent) : null,
    scenario,
  };
}

/** @param {unknown} scenario */
function precoVendaDoCenario(scenario) {
  if (scenario == null || typeof scenario !== "object") return null;
  const s = /** @type {Record<string, unknown>} */ (scenario);
  const m =
    s.marketplace != null && typeof s.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (s.marketplace)
      : null;
  return toDec(s.sale_price_brl ?? m?.sale_price_brl);
}

function margemDoCenario(scenario, extras) {
  if (scenario == null || typeof scenario !== "object") return null;
  const aplicado =
    extras != null && temExtrasPrecificacaoInteligenteAtivos(extras)
      ? aplicarExtrasPrecificacaoInteligente(/** @type {Record<string, unknown>} */ (scenario), extras)
      : /** @type {Record<string, unknown>} */ (scenario);
  const res =
    aplicado.result != null && typeof aplicado.result === "object"
      ? /** @type {Record<string, unknown>} */ (aplicado.result)
      : null;
  return toDec(res?.margin_pct);
}

/**
 * Solver oficial margem → preço.
 * Frete/tarifa são função-degrau do preço: busca binária + refinamento local.
 * Margem avaliada sempre com extras PI quando informados.
 * @param {{
 *   inputs: any;
 *   listingType: ListingTypeChoice;
 *   targetMarginPct: number;
 *   refPriceDec: Decimal;
 *   mlAccessToken: string | null;
 *   referenceZipCode: string | null;
 *   listingUuid: string | null;
 *   financialExtras?: import("./aplicarExtrasPrecificacaoInteligente.js").ExtrasPrecificacaoInteligenteInput | null;
 * }} p
 */
/**
 * ENGINE FINANCEIRA HOMOLOGADA — solver preço ↔ margem (PI / Clássico × Premium).
 *
 * Alterações exigem:
 * - Nova trilha
 * - Nova homologação
 * - Comparação com simulador oficial ML
 *
 * Não alterar sem aprovação explícita.
 * Doc: docs/precificacao/PI_ENGINE_HOMOLOGADA.md
 */
async function resolverPrecoParaMargem(p) {
  const {
    inputs,
    listingType,
    targetMarginPct,
    refPriceDec,
    mlAccessToken,
    referenceZipCode,
    listingUuid,
    financialExtras = null,
  } = p;

  const target = new Decimal(targetMarginPct);
  const TOL_ACEITE = new Decimal("0.01");
  const TOL_ANTECIPADA = new Decimal("0.01");
  const MIN_PRECO = new Decimal("1.00");

  /** @type {{ scenario: Record<string, unknown> | null; margem: Decimal | null } | null} */
  let melhor = null;
  let melhorDiff = null;
  let melhorMargem = null;
  let iterations = 0;

  const registrarMelhor = (/** @type {{ scenario: Record<string, unknown> | null; margem: Decimal | null }} */ ev) => {
    iterations += 1;
    if (ev.margem == null) return;
    const diff = ev.margem.minus(target).abs();
    if (melhorDiff == null || diff.lt(melhorDiff)) {
      melhorDiff = diff;
      melhorMargem = ev.margem;
      melhor = ev;
    }
  };

  const avaliarPreco = async (/** @type {Decimal} */ candidato) => {
    const r = await simularCenarioOficialUnico({
      inputs,
      listingType,
      priceDec: candidato,
      mlAccessToken,
      referenceZipCode,
      listingUuid,
    });
    const margem = margemDoCenario(r.scenario, financialExtras);
    return { scenario: r.scenario, margem };
  };

  let lo = Decimal.max(MIN_PRECO, refPriceDec.mul("0.55").toDecimalPlaces(2, ROUND));
  let hi = refPriceDec.mul("1.35").toDecimalPlaces(2, ROUND);

  for (let e = 0; e < 10; e += 1) {
    const ev = await avaliarPreco(hi);
    registrarMelhor(ev);
    if (ev.margem != null && ev.margem.gte(target)) break;
    hi = hi.mul("1.45");
    if (hi.gt(refPriceDec.mul(25))) break;
  }

  for (let e = 0; e < 8; e += 1) {
    const ev = await avaliarPreco(lo);
    registrarMelhor(ev);
    if (ev.margem != null && ev.margem.lte(target)) break;
    const nextLo = lo.mul("0.72").toDecimalPlaces(2, ROUND);
    if (nextLo.lte(MIN_PRECO) || nextLo.gte(lo)) break;
    lo = Decimal.max(MIN_PRECO, nextLo);
  }

  const MAX_ITER = 28;
  for (let i = 0; i < MAX_ITER; i += 1) {
    if (hi.minus(lo).lte("0.01")) break;
    const mid = lo.plus(hi).div(2).toDecimalPlaces(2, ROUND);
    const ev = await avaliarPreco(mid);
    if (ev.margem == null) break;
    registrarMelhor(ev);
    const diffAbs = ev.margem.minus(target).abs();
    if (diffAbs.lte(TOL_ANTECIPADA)) break;
    if (ev.margem.lt(target)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  if (melhor?.scenario != null) {
    const base = precoVendaDoCenario(melhor.scenario) ?? refPriceDec;
    const deltas = [
      0, 0.01, -0.01, 0.02, -0.02, 0.05, -0.05, 0.1, -0.1, 0.25, -0.25, 0.5, -0.5, 1, -1, 2, -2, 5, -5,
    ];
    for (const delta of deltas) {
      const candidato = base.plus(delta);
      if (candidato.lt(MIN_PRECO)) continue;
      const ev = await avaliarPreco(candidato);
      registrarMelhor(ev);
      if (melhorDiff != null && melhorDiff.lte(TOL_ANTECIPADA)) break;
    }
  }

  if (melhorDiff != null && melhorDiff.gt(TOL_ACEITE) && melhor?.scenario != null) {
    const base = precoVendaDoCenario(melhor.scenario) ?? refPriceDec;
    const baseCents = base.mul(100).round();
    const scanRadius = 200;
    for (let offset = -scanRadius; offset <= scanRadius; offset += 1) {
      const candidato = baseCents.plus(offset).div(100);
      if (candidato.lt(MIN_PRECO)) continue;
      const ev = await avaliarPreco(candidato);
      registrarMelhor(ev);
      if (melhorDiff != null && melhorDiff.lte(TOL_ACEITE)) break;
    }
  }

  const precoResolvido = melhor?.scenario != null ? decToStr2(precoVendaDoCenario(melhor.scenario)) : null;

  const withinTolerance = melhorDiff != null && melhorDiff.lte(TOL_ACEITE);
  console.info("[pricing-margin-solver]", {
    target_margin: decToStr2(target),
    resolved_price: precoResolvido,
    resolved_margin: decToStr2(melhorMargem),
    iterations,
    error_pct: decToStr2(melhorDiff),
    tolerance_accept_pct: decToStr2(TOL_ACEITE),
    within_tolerance: withinTolerance,
    ...(withinTolerance
      ? {}
      : {
          warning:
            "Margem alvo não cravada dentro de ±0,01 p.p. — possível degrau de tarifa/frete ML nesta faixa.",
        }),
  });

  return melhor;
}

/**
 * API principal: simula o cenário oficial por tipo de anúncio, a partir de preço OU margem.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   listingId?: string;
 *   listingExternalId?: string;
 *   listingType: ListingTypeChoice;
 *   salePrice?: string | number | null;
 *   targetMarginPct?: string | number | null;
 *   mlAccessToken?: string | null;
 *   referenceZipCode?: string | null;
 *   financialExtras?: import("./aplicarExtrasPrecificacaoInteligente.js").ExtrasPrecificacaoInteligenteInput | null;
 * }} opts
 */
export async function simulateMercadoLivreListingTypeScenario(supabase, userId, opts) {
  const financialExtras = opts.financialExtras ?? null;
  const listingType = opts.listingType === "premium" ? "premium" : "classic";

  const loaded = opts.listingId
    ? await loadMercadoLivreListingPricingInputs(supabase, userId, String(opts.listingId).trim())
    : opts.listingExternalId
      ? await loadMercadoLivreListingPricingInputsByExternalId(supabase, userId, String(opts.listingExternalId).trim())
      : { ok: false, error: "Informe listingId ou listingExternalId.", status: 400 };

  if (!loaded.ok || !loaded.listing) {
    return { ok: false, error: loaded.error ?? "Falha ao carregar anúncio.", status: loaded.status ?? 500 };
  }

  const inputs = {
    listing: loaded.listing,
    health: loaded.health,
    metrics: loaded.metrics,
    sellerTaxPct: loaded.sellerTaxPct,
    external_listing_id: loaded.external_listing_id,
  };
  const listingUuid = loaded.listing.id != null ? String(loaded.listing.id) : null;
  const mlAccessToken = opts.mlAccessToken ?? null;
  const referenceZipCode =
    opts.referenceZipCode != null && String(opts.referenceZipCode).trim() !== ""
      ? String(opts.referenceZipCode).trim()
      : "01310100";

  const precoInput = toDec(opts.salePrice);
  const margemInput =
    opts.targetMarginPct != null && String(opts.targetMarginPct).trim() !== ""
      ? Number(String(opts.targetMarginPct).replace(",", "."))
      : null;

  const origem = margemInput != null && Number.isFinite(margemInput) && precoInput == null ? "margem" : "preco";

  let resultado = null;
  if (origem === "margem") {
    const refPrice =
      toDec(loaded.listing.price) ??
      toDec(
        loaded.health != null && typeof loaded.health === "object"
          ? /** @type {Record<string, unknown>} */ (loaded.health).list_or_original_price_brl
          : null,
      ) ??
      new Decimal(100);
    resultado = await resolverPrecoParaMargem({
      inputs,
      listingType,
      targetMarginPct: /** @type {number} */ (margemInput),
      refPriceDec: refPrice,
      mlAccessToken,
      referenceZipCode,
      listingUuid,
      financialExtras,
    });
    if (resultado?.scenario != null) {
      const mk =
        resultado.scenario.marketplace != null && typeof resultado.scenario.marketplace === "object"
          ? /** @type {Record<string, unknown>} */ (resultado.scenario.marketplace)
          : {};
      resultado = {
        ...resultado,
        listing_type: listingType,
        listing_type_id: listingTypeIdParaTipo(listingType),
        commission_source:
          resultado.scenario.official_fee_source != null
            ? String(resultado.scenario.official_fee_source)
            : "rayx_engine",
        official_fee_percent: mk.sale_fee_percent != null ? String(mk.sale_fee_percent) : null,
      };
    }
  } else {
    if (precoInput == null || precoInput.lte(0)) {
      return { ok: false, error: "Informe salePrice (> 0) ou targetMarginPct.", status: 400 };
    }
    resultado = await simularCenarioOficialUnico({
      inputs,
      listingType,
      priceDec: precoInput,
      mlAccessToken,
      referenceZipCode,
      listingUuid,
    });
  }

  if (resultado == null || resultado.scenario == null) {
    return {
      ok: false,
      error: "Não foi possível simular este cenário com os dados oficiais disponíveis. Sincronize o anúncio e tente novamente.",
      status: 422,
    };
  }

  const scenario = /** @type {Record<string, unknown>} */ (resultado.scenario);
  const precoFinal = toDec(scenario.sale_price_brl);
  const margemFinal = margemDoCenario(scenario, financialExtras);

  return {
    ok: true,
    data: {
      listing_id: listingUuid,
      external_listing_id: inputs.external_listing_id || "",
      listing_type: resultado.listing_type,
      listing_type_id: resultado.listing_type_id,
      edited_from: origem,
      commission_source: resultado.commission_source,
      official_fee_percent: resultado.official_fee_percent,
      resolved_sale_price_brl: decToStr2(precoFinal),
      resolved_margin_pct: decToStr2(margemFinal),
      scenario,
    },
  };
}
