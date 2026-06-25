// ======================================================
// Cenários de precificação ML — baseline + todas as promoções (ativas/programadas/demais).
// Cada cenário: listing com preço isolado + health sem ancoragem cruzada de repasse/tarifa/frete.
// ======================================================

import Decimal from "decimal.js";
import {
  fetchItem,
  fetchSellerPromotionsByItemDetailed,
  pickPromotionIdFromSalePricePayload,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  mercadoLivreListingPayloadForMoneyFields,
  mercadoLivreToFiniteGrid,
} from "../../handlers/ml/_helpers/mercadoLivreListingMoneyShared.js";
import { coalesceMercadoLibreItemForMoneyExtract } from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import {
  MERCADO_LIVRE_PROMO_PRICE_TOL,
  extractMercadoLivreSalePriceSnapshotFromHealth,
} from "../../handlers/ml/_helpers/mercadoLivrePromotionResolve.js";
import {
  normalizeMercadoLivreListingType,
  resolveMercadoLivreListingPricingForGrid,
} from "../../handlers/ml/_helpers/marketplaces/mercadoLivreListingGrid.js";
import { computeMercadoLivreUnitNetProceeds } from "../../handlers/ml/_helpers/netProceeds/mercadoLivreNetProceedsCalculator.js";
import { buildMercadoLivrePricingContext } from "../../handlers/ml/_helpers/marketplaces/mercadoLivreRaioxPricing.js";
import {
  loadMercadoLivreListingPricingInputs,
  loadMercadoLivreListingPricingInputsByExternalId,
} from "../../handlers/pricing/_helpers/mercadoLivrePricingSimulation.js";
import { logPricingEvent, PRICING_LOG_LEVEL, PRICING_EVENT_CODE } from "./pricingInconsistencyLog.js";
import { inferMercadoLivreShippingContext } from "./mercadoLivreScenarioShipping.js";
import { resolveMercadoLivreScenarioShippingAsync } from "./mercadoLivreScenarioShippingResolve.js";
import {
  deveUsarFreteOficialMercadoLivrePorPreco,
  resolverTarifaOficialMercadoLivrePorPreco,
} from "./mercadoLivreOfficialScenarioResolvers.js";
import {
  resolveMercadoLivreBaselineCatalogBrl,
  resolveMercadoLivrePromotionFinancials,
} from "./strategies/mercadoLivrePromotionResolverStrategy.js";
import { logPricingPiOfficialApiCall } from "./pricingFlowDiffLog.js";
import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";
import {
  buildOfficialSellerPromotionIdentityKey,
  buildPiPromoFlowAuditPayload,
  evaluateOfficialPromotionUiEligibility,
  logS7MlPromosAudit,
  logS7PiPromoFinAuditDeep,
  logS7PiPromoFlowAudit,
  logS7PromotionsPiAudit,
  normalizeOfficialSellerPromotionsFromApi,
  resolveOfficialPromotionPresentationFinancials,
  resolveOfficialSellerPromotionFinancials,
  extractOfficialPromotionFinancialRawFields,
} from "./mercadoLivreOfficialSellerPromotions.js";

/** @param {unknown} v @returns {Decimal | null} */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d @returns {string | null} */
function decToStr2(d) {
  if (d == null) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * @param {Record<string, unknown> | null | undefined} health
 */
function cloneHealthForPricingScenario(health) {
  if (!health || typeof health !== "object") return health;
  return {
    ...health,
    net_receivable: null,
    marketplace_payout_amount: null,
    marketplace_payout_amount_brl: null,
    promotion_price: null,
    promotional_price_brl: null,
    sale_fee_amount: null,
    sale_fee_percent: null,
    shipping_cost: null,
    shipping_cost_amount: null,
    shipping_cost_amount_brl: null,
    shipping_cost_context: null,
    ml_shipping_cost_context: null,
  };
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Decimal} priceDec
 * @param {{ stripCatalogPriceHints?: boolean }} [opts]
 */
function listingWithSalePrice(listing, priceDec, opts = {}) {
  const s = priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const n = Number(s);
  const out = { ...listing, price: Number.isFinite(n) ? n : s };
  if (opts.stripCatalogPriceHints === true) {
    delete out.original_price;
    delete out.base_price;
  }
  if (out.raw_json != null && typeof out.raw_json === "object") {
    const rj = { .../** @type {Record<string, unknown>} */ (out.raw_json), price: out.price };
    if (opts.stripCatalogPriceHints === true) {
      delete rj.original_price;
      delete rj.base_price;
    }
    out.raw_json = rj;
  }
  return out;
}

/**
 * ID estável da promoção na linha `prices[]`: metadata/root, senão id da linha (ML costuma preencher).
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function resolvePromotionIdForPriceRow(row) {
  const fromPayload = pickPromotionIdFromSalePricePayload(row);
  if (fromPayload != null && String(fromPayload).trim() !== "") return String(fromPayload).trim();
  const pid = row.promotion_id ?? row.promotionId;
  if (pid != null && String(pid).trim() !== "") return String(pid).trim();
  const id = row.id;
  if (id != null && String(id).trim() !== "") return String(id).trim();
  return null;
}

/**
 * Classifica status para ordenação: active -> scheduled -> demais.
 * Retorna status normalizado + status cru observado.
 * @param {Record<string, unknown>} meta
 * @param {Record<string, unknown>} row
 * @param {{ inferActiveFromPriceEvidence?: boolean }} [opts]
 */
function classifyPromotionStatus(meta, row, opts = {}) {
  const now = Date.now();
  const st = meta.status ?? row.status;
  const normalizedRaw = st != null ? String(st).trim().toLowerCase() : "";
  const inferActiveFromPriceEvidence = opts.inferActiveFromPriceEvidence === true;
  if (
    normalizedRaw === "active" ||
    normalizedRaw === "started" ||
    normalizedRaw === "running" ||
    normalizedRaw === "ativa" ||
    normalizedRaw === "ativo"
  ) {
    return "active";
  }
  if (
    normalizedRaw === "scheduled" ||
    normalizedRaw === "programada" ||
    normalizedRaw === "programado" ||
    normalizedRaw === "pending" ||
    normalizedRaw === "future" ||
    normalizedRaw === "candidate" ||
    normalizedRaw === "eligible" ||
    normalizedRaw === "available"
  ) {
    return "scheduled";
  }
  if (
    normalizedRaw === "finished" ||
    normalizedRaw === "expired" ||
    normalizedRaw === "cancelled" ||
    normalizedRaw === "inactive" ||
    normalizedRaw === "draft"
  ) {
    return normalizedRaw;
  }

  const endRaw = meta.finish_time ?? meta.end_date ?? meta.date_to ?? row.finish_time ?? row.end_date;
  const startRaw = meta.start_time ?? meta.start_date ?? meta.date_from ?? row.start_time ?? row.start_date;
  if (endRaw != null && String(endRaw).trim() !== "") {
    const t = Date.parse(String(endRaw));
    if (Number.isFinite(t) && t < now - 60_000) return "finished";
  }
  if (startRaw != null && String(startRaw).trim() !== "") {
    const t = Date.parse(String(startRaw));
    if (Number.isFinite(t) && t > now + 60_000) return "scheduled";
    if (Number.isFinite(t) && t <= now + 60_000) return "active";
  }
  // Quando há evidência direta de preço promocional (sale < regular), o cenário representa
  // promoção efetiva e não deve cair em "unknown" (era descartado como ended).
  if (inferActiveFromPriceEvidence) return "active";
  return normalizedRaw !== "" ? normalizedRaw : "unknown";
}

/** @param {string} status */
function promotionStatusSortWeight(status) {
  if (status === "active") return 0;
  if (status === "scheduled") return 1;
  return 2;
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function toIsoDateStringOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** @param {string} listingExternalId */
function shouldEmitPromotionDebug(listingExternalId) {
  const envRaw = process.env.ML_PROMOTION_DEBUG_LISTING_ID;
  if (envRaw != null && String(envRaw).trim() !== "") {
    const wanted = String(envRaw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return wanted.includes(listingExternalId);
  }
  return listingExternalId === "MLB4473427655";
}

/**
 * @param {{ starts_at: string | null; status: string; promotion_name: string }} a
 * @param {{ starts_at: string | null; status: string; promotion_name: string }} b
 */
/**
 * @param {unknown} v
 * @param {string} fallback
 */
function safePromotionLabel(v, fallback = "Promoção") {
  if (v == null) return fallback;
  try {
    const s = String(v).trim();
    return s !== "" ? s : fallback;
  } catch {
    return fallback;
  }
}

function comparePromotionScenarioRows(a, b) {
  const wA = promotionStatusSortWeight(a.status);
  const wB = promotionStatusSortWeight(b.status);
  if (wA !== wB) return wA - wB;
  let sa = NaN;
  let sb = NaN;
  try {
    sa = a.starts_at != null ? Date.parse(String(a.starts_at)) : NaN;
  } catch {
    sa = NaN;
  }
  try {
    sb = b.starts_at != null ? Date.parse(String(b.starts_at)) : NaN;
  } catch {
    sb = NaN;
  }
  const saInf = !Number.isFinite(sa);
  const sbInf = !Number.isFinite(sb);
  const na = safePromotionLabel(a.promotion_name);
  const nb = safePromotionLabel(b.promotion_name);
  if (saInf && sbInf) return na.localeCompare(nb, "pt-BR");
  if (saInf) return 1;
  if (sbInf) return -1;
  if (sa !== sb) return sa - sb;
  return na.localeCompare(nb, "pt-BR");
}

/**
 * @param {{ starts_at: string | null; status: string; promotion_name: string }} current
 * @param {{ starts_at: string | null; status: string; promotion_name: string }} candidate
 */
function pickPreferredPromotionRow(current, candidate) {
  return comparePromotionScenarioRows(current, candidate) <= 0 ? current : candidate;
}

/**
 * Ordenação centralizada do contrato de cenários:
 * baseline primeiro, depois promotion(active/scheduled/demais).
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
function compareScenarioContractRows(a, b) {
  const aKind = String(a.kind ?? (a.is_baseline === true ? "base" : "promotion")).toLowerCase();
  const bKind = String(b.kind ?? (b.is_baseline === true ? "base" : "promotion")).toLowerCase();
  if (aKind === "base" && bKind !== "base") return -1;
  if (bKind === "base" && aKind !== "base") return 1;
  const aView = {
    starts_at: a.starts_at != null ? String(a.starts_at) : null,
    status: a.status != null ? String(a.status) : "unknown",
    promotion_name:
      a.label != null && String(a.label).trim() !== ""
        ? String(a.label)
        : a.promotion_name != null
          ? String(a.promotion_name)
          : "Promoção",
  };
  const bView = {
    starts_at: b.starts_at != null ? String(b.starts_at) : null,
    status: b.status != null ? String(b.status) : "unknown",
    promotion_name:
      b.label != null && String(b.label).trim() !== ""
        ? String(b.label)
        : b.promotion_name != null
          ? String(b.promotion_name)
          : "Promoção",
  };
  return comparePromotionScenarioRows(aView, bView);
}

/**
 * @param {Record<string, unknown>} row
 */
/**
 * ID estável do cenário (API/UI): mesmo `promotion_id` com vigências diferentes ⇒ IDs distintos.
 * @param {unknown} promId
 * @param {unknown} startsAt
 * @param {unknown} endsAt
 */
function buildMlPromotionScenarioId(promId, startsAt, endsAt, offerId = null) {
  const pid = promId != null && String(promId).trim() !== "" ? String(promId).trim() : "";
  const oid = offerId != null && String(offerId).trim() !== "" ? String(offerId).trim() : "";
  let s = "";
  let e = "";
  try {
    s = startsAt != null && String(startsAt).trim() !== "" ? String(startsAt).trim() : "";
  } catch {
    s = "";
  }
  try {
    e = endsAt != null && String(endsAt).trim() !== "" ? String(endsAt).trim() : "";
  } catch {
    e = "";
  }
  if (oid !== "") {
    return pid !== "" ? `${pid}#offer:${oid}` : `offer:${oid}`;
  }
  if (s === "" && e === "") {
    return pid !== "" ? pid : "unknown_promotion";
  }
  if (pid === "") {
    return `noid#${s}#${e}`;
  }
  return `${pid}#${s}#${e}`;
}

/**
 * Chave para agregação em `extractPromotionScenarios` — nunca só promotion_id (colapsa janelas diferentes).
 * @param {{
 *   promotion_id: string;
 *   starts_at: string | null;
 *   ends_at: string | null;
 *   final_price_brl: string;
 *   offer_id?: string | null;
 * }} candidate
 */
function promotionExtractionMapKey(candidate) {
  let pid = "";
  let offerId = "";
  let s = "";
  let e = "";
  let sale = "";
  try {
    pid = candidate.promotion_id != null ? String(candidate.promotion_id).trim() : "";
    offerId = candidate.offer_id != null ? String(candidate.offer_id).trim() : "";
    s = candidate.starts_at != null ? String(candidate.starts_at).trim() : "";
    e = candidate.ends_at != null ? String(candidate.ends_at).trim() : "";
    sale = candidate.final_price_brl != null ? String(candidate.final_price_brl).trim() : "";
  } catch {
    pid = "";
    offerId = "";
    s = "";
    e = "";
    sale = "";
  }
  return `${pid}|${offerId}|${s}|${e}|${sale}`;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function resolveSellerPromotionCampaignId(row) {
  const id = row.id ?? row.promotion_id;
  if (id != null && String(id).trim() !== "") return String(id).trim();
  const ref = row.ref_id;
  if (ref != null && String(ref).trim() !== "") return String(ref).trim();
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function resolveSellerPromotionOfferId(row) {
  const ref = row.ref_id;
  if (ref != null && String(ref).trim() !== "") return String(ref).trim();
  return null;
}

/**
 * Preço efetivo da promoção no ML (candidatas costumam vir com price=0 + suggested_discounted_price).
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function resolveSellerPromotionSalePriceBrl(row) {
  const direct = mercadoLivreToFiniteGrid(row.price ?? row.amount ?? row.deal_price);
  if (direct != null && direct > 0) {
    return new Decimal(direct).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
  for (const field of [
    "suggested_discounted_price",
    "min_discounted_price",
    "max_discounted_price",
    "top_deal_price",
  ]) {
    const v = mercadoLivreToFiniteGrid(row[field]);
    if (v != null && v > 0) {
      return new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} merged
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @returns {number | null}
 */
function resolveSellerPromotionOriginalPrice(row, merged, listing, health) {
  let original = mercadoLivreToFiniteGrid(row.original_price ?? row.regular_amount ?? row.base_price);
  if (original != null && original > 0) return original;
  return (
    mercadoLivreToFiniteGrid(merged.original_price ?? merged.base_price) ??
    mercadoLivreToFiniteGrid(health?.list_or_original_price_brl) ??
    mercadoLivreToFiniteGrid(listing.price)
  );
}

/**
 * @param {ReturnType<typeof extractPromotionScenariosUnsafe>} persistedRows
 * @param {ReturnType<typeof extractPromotionScenariosUnsafe>} liveRows
 */
function mergeExtractedPromotionScenarios(persistedRows, liveRows) {
  /** @type {Map<string, (typeof persistedRows)[number]>} */
  const map = new Map();
  for (const p of [...persistedRows, ...liveRows]) {
    const key = promotionExtractionMapKey(p);
    const current = map.get(key);
    if (current == null) {
      map.set(key, p);
      continue;
    }
    if (current.source === "live" && p.source !== "live") {
      map.set(key, current);
      continue;
    }
    if (p.source === "live" && current.source !== "live") {
      map.set(key, p);
      continue;
    }
    map.set(key, pickPreferredPromotionRow(current, p));
  }
  const out = Array.from(map.values());
  out.sort(comparePromotionScenarioRows);
  return out;
}

function scenarioSourceReliabilityScore(row) {
  let score = 0;
  const pid = row.promotion_id != null ? String(row.promotion_id).trim() : "";
  if (pid !== "") score += 100;
  const src =
    row.marketplace != null && typeof row.marketplace === "object"
      ? String((/** @type {Record<string, unknown>} */ (row.marketplace)).promotion_source ?? "")
      : "";
  if (src === "item_prices_metadata") score += 30;
  else if (src === "catalog_minus_promo_fallback") score += 10;
  const dq =
    row.data_quality != null && typeof row.data_quality === "object"
      ? String((/** @type {Record<string, unknown>} */ (row.data_quality)).source ?? "")
      : "";
  if (dq === "ml_api") score += 20;
  else if (dq === "simulated") score += 10;
  const st = row.status != null ? String(row.status) : "";
  if (st === "active") score += 3;
  else if (st === "scheduled") score += 2;
  return score;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function promotionScenarioIdentityKey(row) {
  try {
    const official = row.ml_official_identity_key;
    if (official != null && String(official).trim() !== "") {
      return `official:${String(official).trim()}`;
    }
    const pid = row.promotion_id != null ? String(row.promotion_id).trim() : "";
    const offerId = row.offer_id != null ? String(row.offer_id).trim() : "";
    const starts = row.starts_at != null ? String(row.starts_at).trim() : "";
    const ends = row.ends_at != null ? String(row.ends_at).trim() : "";
    const sale =
      row.sale_price_brl != null && String(row.sale_price_brl).trim() !== ""
        ? String(row.sale_price_brl).trim()
        : row.marketplace != null &&
            typeof row.marketplace === "object" &&
            (/** @type {Record<string, unknown>} */ (row.marketplace)).sale_price_brl != null
          ? String((/** @type {Record<string, unknown>} */ (row.marketplace)).sale_price_brl).trim()
          : "";
    if (pid !== "") {
      return `promotion_id:${pid}|${offerId}|${starts}|${ends}|${sale}`;
    }
    const label =
      row.label != null && String(row.label).trim() !== ""
        ? String(row.label).trim()
        : row.promotion_name != null
          ? String(row.promotion_name).trim()
          : "";
    if (label === "" && starts === "" && ends === "" && sale === "") return null;
    return `fallback:${label}|${starts}|${ends}|${sale}`;
  } catch {
    return null;
  }
}

/**
 * Guard clause: promoções inválidas não seguem para o frontend.
 * @param {Record<string, unknown>} row
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
function validatePromotionScenarioRow(row) {
  const official = row.ml_official_identity_key;
  if (official != null && String(official).trim() !== "") {
    return { ok: true };
  }
  const key = promotionScenarioIdentityKey(row);
  if (key == null) return { ok: false, reason: "missing_identity" };
  const saleRaw =
    row.sale_price_brl != null && String(row.sale_price_brl).trim() !== ""
      ? String(row.sale_price_brl).trim()
      : row.marketplace != null &&
          typeof row.marketplace === "object" &&
          (/** @type {Record<string, unknown>} */ (row.marketplace)).sale_price_brl != null
        ? String((/** @type {Record<string, unknown>} */ (row.marketplace)).sale_price_brl).trim()
        : "";
  const sale = toDec(saleRaw);
  if (sale == null || !sale.isFinite() || sale.lte(0)) {
    return { ok: false, reason: "invalid_sale_price_brl" };
  }
  return { ok: true };
}

/**
 * Fallback: mantém linhas válidas com identidade única (sem tie-break por score).
 * @param {Record<string, unknown>[]} rows
 */
function fallbackDedupePromotionRows(rows) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (!validatePromotionScenarioRow(row).ok) continue;
    const id = promotionScenarioIdentityKey(row);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  try {
    out.sort(compareScenarioContractRows);
  } catch {
    /* ordem original */
  }
  return out;
}

/**
 * Deduplicação central das promoções já calculadas.
 * @param {Record<string, unknown>[]} rows
 * @param {string | null} listingUuid
 */
function dedupePromotionScenarioRows(rows, listingUuid, counters = null) {
  try {
    /** @type {Map<string, Record<string, unknown>>} */
    const byIdentity = new Map();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const validation = validatePromotionScenarioRow(row);
      if (!validation.ok) {
        if (counters) counters.discarded_invalid += 1;
        logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PROMOTION_SCENARIO_SKIPPED_INVALID, {
          marketplace: "mercado_livre",
          listing_id: listingUuid,
          scenario_id: row.scenario_id ?? null,
          promotion_id: row.promotion_id ?? null,
          reason: validation.reason,
        });
        continue;
      }
      const identity = promotionScenarioIdentityKey(row);
      if (identity == null) continue;
      const current = byIdentity.get(identity);
      if (current == null) {
        byIdentity.set(identity, row);
        continue;
      }
      const currentScore = scenarioSourceReliabilityScore(current);
      const candidateScore = scenarioSourceReliabilityScore(row);
      let takeCandidate = false;
      try {
        takeCandidate =
          candidateScore > currentScore ||
          (candidateScore === currentScore && compareScenarioContractRows(row, current) < 0);
      } catch (cmpErr) {
        logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PRICING_SCENARIOS_PIPELINE_ERROR, {
          marketplace: "mercado_livre",
          listing_id: listingUuid,
          phase: "dedupe_compare",
          promotion_id: row.promotion_id ?? null,
          label: row.label ?? row.promotion_name ?? null,
          starts_at: row.starts_at ?? null,
          ends_at: row.ends_at ?? null,
          reason: cmpErr instanceof Error ? cmpErr.message : String(cmpErr),
        });
        takeCandidate = candidateScore > currentScore;
      }
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_PROMOTION_DEDUPE_DEBUG, {
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        dedupe_key: identity,
        promotion_id: row.promotion_id ?? null,
        label: row.label ?? row.promotion_name ?? null,
        starts_at: row.starts_at ?? null,
        ends_at: row.ends_at ?? null,
        kept_scenario_id: takeCandidate ? row.scenario_id ?? null : current.scenario_id ?? null,
        dropped_scenario_id: takeCandidate ? current.scenario_id ?? null : row.scenario_id ?? null,
      });
      if (takeCandidate) {
        byIdentity.set(identity, row);
      }
    }
    const out = Array.from(byIdentity.values());
    out.sort(compareScenarioContractRows);
    return out;
  } catch (e) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PRICING_SCENARIOS_PIPELINE_ERROR, {
      marketplace: "mercado_livre",
      listing_id: listingUuid,
      phase: "dedupe_promotion_scenarios",
      reason: e instanceof Error ? e.message : String(e),
    });
    return fallbackDedupePromotionRows(rows);
  }
}

/**
 * Promoções válidas para UI de cenários: somente active/scheduled e não encerradas no tempo.
 * @param {{ status?: string | null; ends_at?: string | null }} p
 * @returns {{ ok: true } | { ok: false; reason: "ended" | "expired" }}
 */
function evaluatePromotionUiEligibility(p) {
  const status = p.status != null ? String(p.status).trim().toLowerCase() : "";
  if (status === "expired" || status === "finished" || status === "cancelled" || status === "inactive") {
    return { ok: false, reason: "expired" };
  }
  const permitidos = new Set([
    "active",
    "scheduled",
    "candidate",
    "eligible",
    "available",
    "pending",
  ]);
  if (!permitidos.has(status)) return { ok: false, reason: "ended" };
  if (p.ends_at != null && String(p.ends_at).trim() !== "") {
    const tEnd = Date.parse(String(p.ends_at));
    if (Number.isFinite(tEnd) && tEnd < Date.now()) return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown>} liveItem
 */
function mergeListingWithLivePromotionPayload(listing, liveItem, livePromotions = []) {
  const rawBase =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : {};
  const mergedRaw = {
    ...rawBase,
    ...liveItem,
    prices: Array.isArray(liveItem.prices) ? liveItem.prices : rawBase.prices,
    _suse7_item_promotions: Array.isArray(livePromotions)
      ? livePromotions
      : Array.isArray(rawBase._suse7_item_promotions)
        ? rawBase._suse7_item_promotions
        : undefined,
  };
  return {
    ...listing,
    raw_json: mergedRaw,
    prices: mergedRaw.prices,
    price: liveItem.price ?? listing.price,
    original_price: liveItem.original_price ?? listing.original_price,
    base_price: liveItem.base_price ?? listing.base_price,
  };
}

/**
 * Promoções distintas: chave = promotion_id + vigência + preço de venda (nunca só promotion_id).
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @param {{ source: "persisted" | "live" }} [opts]
 */
function extractPromotionScenariosUnsafe(listing, health, opts = { source: "persisted" }) {
  const TOL = MERCADO_LIVRE_PROMO_PRICE_TOL;
  const merged = coalesceMercadoLibreItemForMoneyExtract(
    mercadoLivreListingPayloadForMoneyFields(listing, health)
  );
  /** @type {Map<string, { promotion_id: string; promotion_name: string; final_price_brl: string; status: string; raw_status: string | null; starts_at: string | null; ends_at: string | null; source: "persisted" | "live" }>} */
  const byPromotionIdentity = new Map();
  const source = opts.source === "live" ? "live" : "persisted";

  /**
   * @param {{
   *   promotion_id: string;
   *   promotion_name: string;
   *   final_price_brl: string;
   *   status: string;
   *   raw_status: string | null;
   *   starts_at: string | null;
   *   ends_at: string | null;
   *   source: "persisted" | "live";
   *   offer_id?: string | null;
   * }} candidate
   */
  function upsertCandidate(candidate) {
    const mapKey = promotionExtractionMapKey(candidate);
    const current = byPromotionIdentity.get(mapKey);
    byPromotionIdentity.set(
      mapKey,
      current == null ? candidate : pickPreferredPromotionRow(current, candidate)
    );
  }

  const prices = merged.prices;
  if (Array.isArray(prices)) {
    for (const pr of prices) {
      if (!pr || typeof pr !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (pr);
      const pid = resolvePromotionIdForPriceRow(row);
      if (!pid) continue;
      const amt = mercadoLivreToFiniteGrid(row.amount ?? row.price);
      const meta =
        row.metadata != null && typeof row.metadata === "object"
          ? /** @type {Record<string, unknown>} */ (row.metadata)
          : /** @type {Record<string, unknown>} */ ({});
      const reg = mercadoLivreToFiniteGrid(
        row.regular_amount ?? meta.promotion_price ?? meta.regular_amount ?? meta.list_price
      );
      if (amt == null || reg == null || reg <= amt + TOL) continue;
      const nameRaw =
        meta.promotion_name ??
        meta.name ??
        row.type ??
        row.promotion_name ??
        row.name ??
        row.condition;
      const name =
        nameRaw != null && String(nameRaw).trim() !== ""
          ? String(nameRaw).trim()
          : `Promoção ${pid}`;
      const startsAt = toIsoDateStringOrNull(
        meta.start_time ?? meta.start_date ?? meta.date_from ?? row.start_time ?? row.start_date
      );
      const endsAt = toIsoDateStringOrNull(
        meta.finish_time ?? meta.end_date ?? meta.date_to ?? row.finish_time ?? row.end_date ?? row.stop_time
      );
      const rawStatus =
        meta.status != null && String(meta.status).trim() !== ""
          ? String(meta.status).trim()
          : row.status != null && String(row.status).trim() !== ""
            ? String(row.status).trim()
            : null;
      const status = classifyPromotionStatus(meta, row, { inferActiveFromPriceEvidence: true });
      upsertCandidate({
        promotion_id: pid,
        promotion_name: name,
        final_price_brl: new Decimal(amt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        status,
        raw_status: rawStatus,
        starts_at: startsAt,
        ends_at: endsAt,
        source,
      });
    }
  }

  const rawListing =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;
  const rawItemPromotions = rawListing?._suse7_item_promotions;
  if (Array.isArray(rawItemPromotions)) {
    for (const p of rawItemPromotions) {
      if (!p || typeof p !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (p);
      const pid = resolveSellerPromotionCampaignId(row);
      if (!pid) continue;
      const offerId = resolveSellerPromotionOfferId(row);
      const saleStr = resolveSellerPromotionSalePriceBrl(row);
      if (saleStr == null) continue;
      const originalNum = resolveSellerPromotionOriginalPrice(row, merged, listing, health);
      if (originalNum != null && originalNum <= Number(saleStr) + TOL) {
        const rawStatusProbe =
          row.status != null && String(row.status).trim() !== "" ? String(row.status).trim().toLowerCase() : "";
        const opportunityLike = new Set([
          "candidate",
          "eligible",
          "available",
          "pending",
          "scheduled",
          "programada",
          "programado",
          "future",
          "started",
          "active",
        ]);
        if (!opportunityLike.has(rawStatusProbe)) continue;
      }
      const startsAt = toIsoDateStringOrNull(
        row.start_date ??
          row.start_time ??
          row.date_from ??
          row.starts_at
      );
      const endsAt = toIsoDateStringOrNull(
        row.end_date ??
          row.finish_date ??
          row.finish_time ??
          row.date_to ??
          row.ends_at ??
          row.stop_time
      );
      const rawStatus = row.status != null && String(row.status).trim() !== "" ? String(row.status).trim() : null;
      const status = classifyPromotionStatus({}, row, { inferActiveFromPriceEvidence: true });
      const nameRaw = row.name ?? row.promotion_name ?? row.type;
      const name =
        nameRaw != null && String(nameRaw).trim() !== "" ? String(nameRaw).trim() : `Promoção ${pid}`;
      upsertCandidate({
        promotion_id: pid,
        promotion_name: name,
        final_price_brl: saleStr,
        status,
        raw_status: rawStatus,
        starts_at: startsAt,
        ends_at: endsAt,
        source,
        offer_id: offerId,
      });
    }
  }

  // 2) Fallback (crítico): sem prices[] no item, mas health + lista vs promo coerentes — estilo sale < base.
  if (byPromotionIdentity.size === 0 && health && typeof health === "object") {
    const dbList =
      mercadoLivreToFiniteGrid(health.list_or_original_price_brl) ??
      mercadoLivreToFiniteGrid(listing.price);
    const promoCol =
      mercadoLivreToFiniteGrid(health.promotional_price_brl) ??
      mercadoLivreToFiniteGrid(health.promotion_price);
    const saleEff = mercadoLivreToFiniteGrid(health.marketplace_sale_price_amount);

    let sale = promoCol;
    if (sale == null && saleEff != null && dbList != null && saleEff > 0 && saleEff < dbList - TOL) {
      sale = saleEff;
    }

    const snap = extractMercadoLivreSalePriceSnapshotFromHealth(health);
    const pidFromSnap = snap ? pickPromotionIdFromSalePricePayload(/** @type {Record<string, unknown>} */ (snap)) : null;
    const promId = pidFromSnap != null && String(pidFromSnap).trim() !== "" ? String(pidFromSnap).trim() : "fallback";

    if (sale != null && dbList != null && sale > 0 && dbList > 0 && sale < dbList - TOL) {
      const rj = listing.raw_json;
      let promName = `Promoção ${promId}`;
      if (rj && typeof rj === "object" && "_suse7_seller_promotion_details" in rj) {
        const det = /** @type {Record<string, unknown>} */ (rj)._suse7_seller_promotion_details;
        if (det && typeof det === "object" && det.name != null && String(det.name).trim() !== "") {
          promName = String(det.name).trim();
        }
      }
      const healthRaw =
        health.raw_json != null && typeof health.raw_json === "object"
          ? /** @type {Record<string, unknown>} */ (health.raw_json)
          : null;
      const healthPayloads =
        healthRaw?.raw_payloads != null &&
        typeof healthRaw.raw_payloads === "object" &&
        !Array.isArray(healthRaw.raw_payloads)
          ? /** @type {Record<string, unknown>} */ (healthRaw.raw_payloads)
          : null;
      const sellerPromotionDetails =
        healthPayloads?.seller_promotion_from_sale_price != null &&
        typeof healthPayloads.seller_promotion_from_sale_price === "object" &&
        !Array.isArray(healthPayloads.seller_promotion_from_sale_price)
          ? /** @type {Record<string, unknown>} */ (healthPayloads.seller_promotion_from_sale_price)
          : null;
      const spMeta =
        snap &&
        snap.metadata != null &&
        typeof snap.metadata === "object" &&
        !Array.isArray(snap.metadata)
          ? /** @type {Record<string, unknown>} */ (snap.metadata)
          : /** @type {Record<string, unknown>} */ ({});
      const startsAt = toIsoDateStringOrNull(
        sellerPromotionDetails?.start_time ??
          sellerPromotionDetails?.start_date ??
          sellerPromotionDetails?.date_from ??
          spMeta.start_time ??
          spMeta.start_date ??
          spMeta.date_from ??
          snap?.start_time ??
          snap?.start_date
      );
      const endsAt = toIsoDateStringOrNull(
        sellerPromotionDetails?.finish_time ??
          sellerPromotionDetails?.end_date ??
          sellerPromotionDetails?.date_to ??
          spMeta.finish_time ??
          spMeta.end_date ??
          spMeta.date_to ??
          snap?.finish_time ??
          snap?.end_date
      );
      const statusRow = {
        .../** @type {Record<string, unknown>} */ (snap ?? {}),
        ...sellerPromotionDetails,
      };
      const rawStatus =
        sellerPromotionDetails?.status != null && String(sellerPromotionDetails.status).trim() !== ""
          ? String(sellerPromotionDetails.status).trim()
          : spMeta.status != null && String(spMeta.status).trim() !== ""
            ? String(spMeta.status).trim()
            : statusRow.status != null && String(statusRow.status).trim() !== ""
              ? String(statusRow.status).trim()
              : null;
      const status = classifyPromotionStatus(spMeta, statusRow, { inferActiveFromPriceEvidence: true });
      upsertCandidate({
        promotion_id: promId,
        promotion_name: promName,
        final_price_brl: new Decimal(sale).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        status,
        raw_status: rawStatus,
        starts_at: startsAt,
        ends_at: endsAt,
        source,
      });
    }
  }

  const out = Array.from(byPromotionIdentity.values());
  out.sort(comparePromotionScenarioRows);
  return out;
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @param {{ source: "persisted" | "live" }} [opts]
 */
function extractPromotionScenarios(listing, health, opts = { source: "persisted" }) {
  try {
    return extractPromotionScenariosUnsafe(listing, health, opts);
  } catch (e) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PRICING_SCENARIOS_PIPELINE_ERROR, {
      marketplace: "mercado_livre",
      phase: "extract_promotion_scenarios",
      reason: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @param {(v: unknown) => string | null} decStrFn
 */
function resolveBaselineSalePriceStr(listing, health, decStrFn) {
  const priceCandidate = listing.price ?? listing.base_price;
  const dbListNum = mercadoLivreToFiniteGrid(health?.list_or_original_price_brl);
  const dbPromoNumRaw =
    mercadoLivreToFiniteGrid(health?.promotional_price_brl) ??
    mercadoLivreToFiniteGrid(health?.promotion_price);
  const pricingResolution =
    health?.raw_json &&
    typeof health.raw_json === "object" &&
    /** @type {Record<string, unknown>} */ (health.raw_json).suse7_pricing_resolution
      ? /** @type {Record<string, unknown>} */ (
          /** @type {Record<string, unknown>} */ (health.raw_json).suse7_pricing_resolution
        )
      : null;
  const gridPricing = resolveMercadoLivreListingPricingForGrid(
    {
      listing,
      health: health ?? null,
      pricingResolution,
      dbListNum,
      dbPromoNum: dbPromoNumRaw,
      priceCandidate,
      priceStrFallback: decStrFn(priceCandidate),
    },
    decStrFn
  );
  if (gridPricing.promotion_active === true && gridPricing.listing_price_brl != null) {
    return gridPricing.listing_price_brl;
  }
  return (
    gridPricing.effective_sale_price_brl ??
    gridPricing.listing_price_brl ??
    decStrFn(listing.price) ??
    null
  );
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function decStr(v) {
  if (v == null || v === "") return null;
  try {
    return new Decimal(String(v)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    return null;
  }
}

/**
 * Repasse alinhado ao fechamento exibido: preço − tarifa (R$) − custo de envio seller (líquido).
 * O subsídio ML no frete, quando mostrado à parte, já está embutido no custo líquido (simulação API).
 * Sem frete resolvido: mantém repasse do net_proceeds (não inventar).
 * @param {Decimal} priceDec
 * @param {string | null | undefined} feeAmtStr
 * @param {string | null | undefined} shipStr
 * @param {string | null | undefined} npFallbackPayout
 * @returns {string | null}
 */
/**
 * Tarifa em R$ para o preço do cenário.
 * Nunca reutiliza amount de outra faixa (ex.: 40,49 do catálogo em promo 284,90).
 * @param {Decimal} priceDec
 * @param {string | null | undefined} feePctStr
 * @param {string | null | undefined} feeAmtCandidate
 * @param {{
 *   officialSource?: string | null;
 *   preferOfficialAmount?: boolean;
 *   trustPercentForScenarioPrice?: boolean;
 * }} [opts]
 * @returns {string | null}
 */
function resolveScenarioSaleFeeAmountBrl(priceDec, feePctStr, feeAmtCandidate, opts = {}) {
  const { officialSource = null, preferOfficialAmount = false, trustPercentForScenarioPrice = false } =
    opts;
  const TOL = new Decimal("0.02");

  if (preferOfficialAmount && feeAmtCandidate != null && String(feeAmtCandidate).trim() !== "") {
    const amtDec = toDec(String(feeAmtCandidate).trim());
    if (amtDec != null && amtDec.gte(0)) {
      return decToStr2(amtDec);
    }
  }

  const pct = toDec(feePctStr);
  const fromPct =
    pct != null && pct.gt(0) && priceDec.isFinite() && priceDec.gt(0)
      ? priceDec.mul(pct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : null;

  const candDec =
    feeAmtCandidate != null && String(feeAmtCandidate).trim() !== ""
      ? toDec(String(feeAmtCandidate).trim())
      : null;

  if (fromPct != null) {
    if (candDec != null && candDec.gte(0) && candDec.minus(fromPct).abs().lte(TOL)) {
      return decToStr2(candDec);
    }
    if (
      trustPercentForScenarioPrice ||
      officialSource === "ml_listing_prices" ||
      candDec == null
    ) {
      return decToStr2(fromPct);
    }
  }

  if (candDec != null && candDec.gte(0)) {
    return decToStr2(candDec);
  }
  return null;
}

function computeAlignedMarketplacePayoutBrl(priceDec, feeAmtStr, shipStr, npFallbackPayout) {
  const fee = toDec(feeAmtStr);
  const ship = toDec(shipStr);
  const fb =
    npFallbackPayout != null && String(npFallbackPayout).trim() !== ""
      ? String(npFallbackPayout).trim()
      : null;
  if (!priceDec.isFinite() || fee == null) return fb;
  if (ship != null) {
    return decToStr2(priceDec.minus(fee).minus(ship));
  }
  return fb;
}

/** @param {Record<string, unknown>} np */
function netProceedsDataQualitySource(np) {
  const src = np.source != null ? String(np.source) : "";
  if (src === "marketplace_api" || src === "marketplace_listing_health") return "ml_api";
  if (src === "calculated") return "simulated";
  if (src === "insufficient_data") return "partial";
  return "partial";
}

/**
 * @param {{
 *   listing: Record<string, unknown>;
 *   health: Record<string, unknown> | null;
 *   metrics: Record<string, unknown> | null;
 *   sellerTaxPct: string | null;
 *   salePriceStr: string;
 *   scenario_id: string;
 *   promotion_id: string | null;
 *   promotion_name: string | null;
 *   promotion_status?: string | null;
 *   starts_at?: string | null;
 *   ends_at?: string | null;
 *   promotion_active: boolean;
 *   is_baseline: boolean;
 *   mlAccessToken?: string | null;
 *   referenceZipCode?: string | null;
 *   itemMlId?: string | null;
 *   listingUuid?: string | null;
 *   promotionFinancials?: Record<string, unknown> | null;
 *   officialMlFee?: { amount_brl?: string | null; percent?: string | null; source?: string | null } | null;
 *   pricingIntelligenceSimulate?: boolean;
 *   piCustomPriceOfficialApis?: boolean;
 * }} p
 * @returns {Promise<Record<string, unknown>>}
 */
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
export async function computeOneScenario(p) {
  const {
    listing,
    health,
    metrics,
    sellerTaxPct,
    salePriceStr,
    scenario_id,
    promotion_id,
    promotion_name,
    promotion_status,
    starts_at,
    ends_at,
    promotion_active,
    is_baseline,
  } = p;
  const offer_id = p.offer_id != null && String(p.offer_id).trim() !== "" ? String(p.offer_id).trim() : null;
  const scenarioKey = is_baseline
    ? "base"
    : `ml:promotion:${
        scenario_id != null && String(scenario_id).trim() !== ""
          ? String(scenario_id).trim()
          : String(promotion_id ?? "")
      }`;
  const scenarioKind = is_baseline ? "base" : "promotion";
  const scenarioLabel = is_baseline ? "Preço normal" : promotion_name ?? `Promoção ${promotion_id ?? scenario_id}`;
  const scenarioStatus = is_baseline ? "current" : promotion_status ?? "unknown";
  const scenarioStartsAt = starts_at ?? null;
  const scenarioEndsAt = ends_at ?? null;

  let priceDec;
  try {
    priceDec = new Decimal(String(salePriceStr).trim().replace(",", "."));
  } catch {
    priceDec = new Decimal(NaN);
  }

  const productCosts =
    listing.product_cost_row && typeof listing.product_cost_row === "object"
      ? /** @type {Record<string, unknown>} */ (listing.product_cost_row)
      : null;

  const warnings = [];
  if (!priceDec.isFinite() || priceDec.lte(0)) {
    return {
      key: scenarioKey,
      kind: scenarioKind,
      label: scenarioLabel,
      status: scenarioStatus,
      starts_at: scenarioStartsAt,
      ends_at: scenarioEndsAt,
      scenario_id,
      promotion_id,
      promotion_name,
      promotion_active,
      is_baseline,
      offer_id,
      marketplace: {
        sale_price_brl: null,
        original_price_brl: null,
        listing_type_label: normalizeMercadoLivreListingType(
          listing.listing_type_id != null ? String(listing.listing_type_id) : null
        ).label,
        sale_fee_percent: null,
        sale_fee_amount_brl: null,
        shipping_cost_amount_brl: null,
        shipping_cost_source: null,
        shipping_context: null,
        shipping_subsidy_amount_brl: null,
        promotion_subsidy_amount_brl: null,
        seller_discount_amount_brl: null,
        promotion_source: null,
        is_shipping_estimated: false,
        is_promotion_estimated: false,
        marketplace_payout_amount_brl: null,
        margin_amount_brl: null,
        margin_percent: null,
      },
      subsidies: null,
      internal_costs: {
        product_cost_brl: null,
        tax_amount_brl: null,
        operational_packaging_total_brl: null,
        tax_percent_applied: null,
        tax_percent_label: null,
      },
      result: null,
      ui: {
        block2_mode: "blocked",
        block3_mode: "blocked",
        block2_message: null,
        block3_message: null,
      },
      data_quality: {
        source: "partial",
        warnings: ["Preço do cenário inválido ou ausente."],
      },
      sale_price_brl: null,
      fee_amount_brl: null,
      shipping_cost_brl: null,
      net_receivable_brl: null,
    };
  }

  const salePriceStrOfficial = priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const itemMlId =
    p.itemMlId != null && String(p.itemMlId).trim() !== "" ? String(p.itemMlId).trim() : null;
  const mlAccessToken =
    p.mlAccessToken != null && String(p.mlAccessToken).trim() !== "" ? String(p.mlAccessToken).trim() : null;

  const listingSim = listingWithSalePrice(listing, priceDec, {
    stripCatalogPriceHints:
      p.pricingIntelligenceSimulate === true ||
      p.officialMlFee != null ||
      Boolean(mlAccessToken && itemMlId),
  });
  let healthSim = cloneHealthForPricingScenario(health);

  /** @type {{ amount_brl?: string | null; percent?: string | null; source?: string | null } | null} */
  let officialFee = p.officialMlFee ?? null;
  if (mlAccessToken && itemMlId) {
    const fetched = await resolverTarifaOficialMercadoLivrePorPreco({
      accessToken: mlAccessToken,
      listing: listingSim,
      externalListingId: itemMlId,
      listingTypeId:
        listingSim.listing_type_id != null ? String(listingSim.listing_type_id).trim() : null,
      priceDec,
      listingUuid: p.listingUuid ?? null,
      scenarioType: scenario_id,
    });
    if (fetched != null && fetched.source === "ml_listing_prices") {
      officialFee = fetched;
    }
  }

  if (officialFee?.percent != null && String(officialFee.percent).trim() !== "") {
    healthSim = {
      ...healthSim,
      sale_fee_percent: String(officialFee.percent).trim(),
      sale_fee_amount:
        officialFee.amount_brl != null && String(officialFee.amount_brl).trim() !== ""
          ? String(officialFee.amount_brl).trim()
          : null,
    };
  }

  const np = computeMercadoLivreUnitNetProceeds(listingSim, healthSim, metrics);
  const npOk = Boolean(np && /** @type {Record<string, unknown>} */ (np).has_valid_data === true);

  const lt = normalizeMercadoLivreListingType(
    listing.listing_type_id != null ? String(listing.listing_type_id) : null
  );

  const npRec = np && typeof np === "object" ? /** @type {Record<string, unknown>} */ (np) : {};

  const useOfficialShippingByPrice =
    p.pricingIntelligenceSimulate === true ||
    deveUsarFreteOficialMercadoLivrePorPreco({
      mlAccessToken,
      itemMlId,
      referenceZipCode: p.referenceZipCode ?? null,
    });

  const feePctStr =
    officialFee?.percent != null && String(officialFee.percent).trim() !== ""
      ? String(officialFee.percent).trim()
      : p.pricingIntelligenceSimulate !== true &&
          npRec.sale_fee_percent != null &&
          String(npRec.sale_fee_percent).trim() !== ""
        ? String(npRec.sale_fee_percent).trim()
        : null;

  const feeAmtOficialMl =
    officialFee?.source === "ml_listing_prices" &&
    officialFee?.amount_brl != null &&
    String(officialFee.amount_brl).trim() !== ""
      ? String(officialFee.amount_brl).trim()
      : null;

  const npFeeAmt =
    !p.pricingIntelligenceSimulate && useOfficialShippingByPrice === false
      ? npRec.sale_fee_amount != null && String(npRec.sale_fee_amount).trim() !== ""
        ? String(npRec.sale_fee_amount).trim()
        : null
      : null;

  let feeAmtStrResolved = feeAmtOficialMl ?? npFeeAmt ?? null;
  feeAmtStrResolved = resolveScenarioSaleFeeAmountBrl(priceDec, feePctStr, feeAmtStrResolved, {
    officialSource: officialFee?.source ?? null,
    preferOfficialAmount: officialFee?.source === "ml_listing_prices",
    trustPercentForScenarioPrice:
      p.pricingIntelligenceSimulate === true ||
      p.piCustomPriceOfficialApis === true ||
      useOfficialShippingByPrice ||
      officialFee?.source === "ml_listing_prices",
  });
  /** Repasse/lucro usam override; alinhar também `sale_fee_amount` no objeto para leitores futuros. */
  const npAdjusted =
    np && typeof np === "object"
      ? { .../** @type {Record<string, unknown>} */ (np), sale_fee_amount: feeAmtStrResolved }
      : np;
  const payoutStrResolved =
    npRec.marketplace_payout_amount_brl ??
    npRec.marketplace_payout_amount ??
    npRec.net_proceeds_amount ??
    null;
  const payoutTrim =
    payoutStrResolved != null && String(payoutStrResolved).trim() !== ""
      ? String(payoutStrResolved).trim()
      : null;

  if (p.pricingIntelligenceSimulate === true && !mlAccessToken) {
    warnings.push("Token ML indisponível — tarifa/frete oficial não consultados para este preço.");
  }

  const piCustomPriceOfficialApis = p.piCustomPriceOfficialApis === true;
  const listingRaw =
    listingSim.raw_json != null && typeof listingSim.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listingSim.raw_json)
      : {};
  const listingShipping =
    listingRaw.shipping != null && typeof listingRaw.shipping === "object"
      ? /** @type {Record<string, unknown>} */ (listingRaw.shipping)
      : listingSim.shipping != null && typeof listingSim.shipping === "object"
        ? /** @type {Record<string, unknown>} */ (listingSim.shipping)
        : null;
  /** @type {Record<string, unknown>} */
  const piFeeDebug = {
    request_url: officialFee?.debug?.request_url ?? null,
    response_status: officialFee?.debug?.response_status ?? null,
    fee_amount_brl: feeAmtStrResolved,
    fee_percent: feePctStr,
  };

  const resolvedShipping = await resolveMercadoLivreScenarioShippingAsync({
    accessToken: mlAccessToken,
    itemId: itemMlId,
    zipCode: p.referenceZipCode ?? null,
    scenarioSaleDec: priceDec,
    npRec,
    healthOriginal: health,
    listing: listingSim,
    scenarioType: scenario_id,
    listingUuid: p.listingUuid ?? null,
    preferItemShippingOptionsByPrice: useOfficialShippingByPrice && !piCustomPriceOfficialApis,
    piFreteViaShippingOptionsFree: piCustomPriceOfficialApis,
    piOfficialApiContext: piCustomPriceOfficialApis
      ? {
          categoryId:
            listingSim.category_id != null
              ? String(listingSim.category_id)
              : listingRaw.category_id != null
                ? String(listingRaw.category_id)
                : null,
          listingTypeId:
            listingSim.listing_type_id != null ? String(listingSim.listing_type_id).trim() : null,
          currencyId:
            listingSim.currency_id != null ? String(listingSim.currency_id).trim() : "BRL",
          logisticType:
            listingShipping?.logistic_type != null
              ? String(listingShipping.logistic_type).trim()
              : null,
          shippingMode:
            listingShipping?.mode != null ? String(listingShipping.mode).trim() : null,
          feeDebug: piFeeDebug,
        }
      : null,
    officialFeeAmountBrl: feeAmtStrResolved,
  });

  if (
    piCustomPriceOfficialApis &&
    resolvedShipping.amount_brl == null &&
    (officialFee?.source === "ml_listing_prices" || feeAmtStrResolved != null)
  ) {
    logPricingPiOfficialApiCall({
      listing_id: p.listingUuid ?? itemMlId ?? null,
      sale_price: salePriceStrOfficial,
      category_id:
        listingSim.category_id != null
          ? String(listingSim.category_id)
          : listingRaw.category_id != null
            ? String(listingRaw.category_id)
            : null,
      listing_type_id:
        listingSim.listing_type_id != null ? String(listingSim.listing_type_id).trim() : null,
      currency_id: listingSim.currency_id != null ? String(listingSim.currency_id).trim() : "BRL",
      logistic_type:
        listingShipping?.logistic_type != null
          ? String(listingShipping.logistic_type).trim()
          : null,
      shipping_mode: listingShipping?.mode != null ? String(listingShipping.mode).trim() : null,
      fee_url: piFeeDebug.request_url,
      fee_status: piFeeDebug.response_status,
      fee_amount_brl: feeAmtStrResolved,
      fee_percent: feePctStr,
      shipping_url_free_true: null,
      shipping_status_free_true: null,
      shipping_cost_free_true: null,
      shipping_url_free_false: null,
      shipping_status_free_false: null,
      shipping_cost_free_false: null,
      selected_shipping_cost_brl: null,
      selected_shipping_context: null,
      fallback_used: true,
    });
  }
  const shipTrim = resolvedShipping.amount_brl;
  const shippingCostSource = resolvedShipping.source;
  const shippingCtx =
    resolvedShipping.shipping_context ?? inferMercadoLivreShippingContext(npRec, health);

  const pf = p.promotionFinancials;

  const payoutAlignedBrl = computeAlignedMarketplacePayoutBrl(
    priceDec,
    feeAmtStrResolved,
    shipTrim,
    payoutTrim
  );

  const ctx = buildMercadoLivrePricingContext({
    listing: listingSim,
    health: healthSim,
    netProceeds: npAdjusted,
    productCosts,
    sellerTaxPct,
    effectiveSalePriceBrl: priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    marketplacePayoutOverrideBrl: payoutAlignedBrl,
  });

  if (!npOk && officialFee?.source === "ml_listing_prices" && shipTrim != null && payoutAlignedBrl != null) {
    /* Repasse/tarifa oficiais por preço — não exibir alerta de health stale. */
  } else if (!npOk) {
    warnings.push("Dados de repasse/tarifa incompletos para este preço — sincronize o anúncio ou verifique o health.");
  }
  if (feePctStr == null && feeAmtStrResolved == null) {
    warnings.push("Tarifa (% e R$) indisponível neste cenário.");
  } else if (feeAmtStrResolved == null) {
    warnings.push("Tarifa em R$ indisponível neste cenário.");
  }
  if (payoutAlignedBrl == null && payoutTrim == null) {
    warnings.push("Repasse (você recebe) indisponível para este preço.");
  }
  if (shipTrim == null) {
    warnings.push("Custo de envio indisponível neste cenário (sem fechamento venda − tarifa − repasse).");
  }

  /** @type {string[]} */
  const warningsDedup = [...new Set(warnings)];

  let dqSource = netProceedsDataQualitySource(npRec);
  if (!npOk || warningsDedup.length > 0) dqSource = "partial";

  const ic =
    ctx.internal_costs != null && typeof ctx.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.internal_costs)
      : null;
  const res =
    ctx.result != null && typeof ctx.result === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.result)
      : null;
  const ui =
    ctx.ui != null && typeof ctx.ui === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.ui)
      : null;

  const marginAmt = res?.profit_brl != null ? String(res.profit_brl) : null;
  const marginPct = res?.margin_pct != null ? String(res.margin_pct) : null;

  logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_FINANCIALS_RESOLVED, {
    marketplace: "mercado_livre",
    listing_id: p.listingUuid ?? null,
    scenario_id,
    scenario_type: scenario_id,
    sale_price_brl: priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    official_fee_brl: feeAmtStrResolved,
    official_fee_percent: feePctStr,
    official_fee_source: officialFee?.source ?? null,
    shipping_source: shippingCostSource,
    shipping_context: shippingCtx,
    payout_brl: payoutAlignedBrl ?? payoutTrim,
    is_shipping_estimated: resolvedShipping.is_shipping_estimated,
    promotion_source: pf?.promotion_source != null ? String(pf.promotion_source) : null,
  });

  if (p.pricingIntelligenceSimulate === true || useOfficialShippingByPrice) {
    console.info("[pricing-official-scenario]", {
      sale_price: salePriceStrOfficial,
      fee_amount_brl: feeAmtStrResolved,
      shipping_cost_brl: shipTrim,
      payout_brl: payoutAlignedBrl ?? payoutTrim,
      profit_brl: marginAmt,
      margin_percent: marginPct,
      fee_source: officialFee?.source ?? null,
      shipping_source: shippingCostSource,
      shipping_context: shippingCtx,
    });
  }

  const rayxScenarioType = is_baseline
    ? "current_price"
    : promotion_id != null
      ? "promotion"
      : null;
  if (rayxScenarioType != null) {
    console.info("[pricing-rayx-scenario]", {
      scenario_type: rayxScenarioType,
      sale_price: salePriceStrOfficial,
      fee_amount_brl: feeAmtStrResolved,
      shipping_cost_brl: shipTrim,
      payout_brl: payoutAlignedBrl ?? payoutTrim,
      fee_source: officialFee?.source ?? null,
      shipping_source: shippingCostSource,
      shipping_context: shippingCtx,
    });
  }

  const isLowPriceDebug =
    p.pricingIntelligenceSimulate === true &&
    (salePriceStrOfficial === "109.00" ||
      salePriceStrOfficial === "65.00" ||
      salePriceStrOfficial === "85.00" ||
      salePriceStrOfficial === "40.00" ||
      priceDec.lt(150));
  if (isLowPriceDebug) {
    const feeDebug =
      officialFee?.debug != null && typeof officialFee.debug === "object"
        ? /** @type {Record<string, unknown>} */ (officialFee.debug)
        : {};
    const shippingEndpoint =
      shippingCostSource === "ml_item_shipping_options_api" ||
      (typeof shippingCostSource === "string" && shippingCostSource.startsWith("ml_item_shipping_options_api"))
        ? "GET /items/{id}/shipping_options?price=&zip_code="
        : shippingCostSource === "ml_listing_prices_logistics" ||
            shippingCostSource === "ml_listing_prices_logistics_validated"
          ? "GET /sites/{site_id}/listing_prices"
          : shippingCostSource === "ml_shipping_options_free" ||
              shippingCostSource === "ml_shipping_options_free_list_cost"
            ? "GET /users/{id}/shipping_options/free"
            : shippingCostSource ?? "none";
    const feeFound =
      officialFee?.source === "ml_listing_prices" &&
      feeAmtStrResolved != null &&
      String(feeAmtStrResolved).trim() !== "";
    const shippingFound =
      shipTrim != null &&
      shippingCostSource != null &&
      shippingCostSource !== "official_unresolved" &&
      shippingCostSource !== "health_column" &&
      shippingCostSource !== "net_receivable_gap" &&
      !String(shippingCostSource).includes("simulation") &&
      !String(shippingCostSource).includes("shipping_options_free");
    const fallbackUsed = !feeFound || !shippingFound || resolvedShipping.is_shipping_estimated === true;
    console.info("[ml-low-price-official-debug]", {
      listing_id: itemMlId ?? p.listingUuid ?? null,
      sale_price: salePriceStrOfficial,
      endpoint: feeDebug.endpoint ?? "GET /sites/{site_id}/listing_prices",
      request_payload_or_query: feeDebug.request_url ?? null,
      response_status: feeDebug.response_status ?? null,
      price_sent_to_ml: feeDebug.price_sent ?? salePriceStrOfficial,
      listing_type_id: feeDebug.listing_type_id ?? null,
      category_id: feeDebug.category_id ?? null,
      fee_found: feeFound,
      fee_amount_brl: feeAmtStrResolved,
      fee_percent: feePctStr,
      shipping_endpoint: shippingEndpoint,
      shipping_found: shippingFound,
      shipping_cost_brl: shipTrim,
      buyer_shipping_context: shippingCtx,
      payout_brl: payoutAlignedBrl ?? payoutTrim,
      fallback_used: fallbackUsed,
      warning: warningsDedup.length ? warningsDedup.join(" ") : null,
    });
  }

  console.info("[ml-official-scenario-final]", {
    listing_id: p.listingUuid ?? null,
    external_listing_id: itemMlId,
    scenario_id,
    sale_price: salePriceStrOfficial,
    fee_amount_brl: feeAmtStrResolved,
    fee_percent: feePctStr,
    fee_source: officialFee?.source ?? null,
    shipping_cost_brl: shipTrim,
    shipping_source: shippingCostSource,
    shipping_context: shippingCtx,
    payout_brl: payoutAlignedBrl ?? payoutTrim,
    profit_brl: marginAmt,
    margin_percent: marginPct,
    is_shipping_estimated: resolvedShipping.is_shipping_estimated,
    shipping_warning: resolvedShipping.warning ?? null,
  });

  return {
    key: scenarioKey,
    kind: scenarioKind,
    label: scenarioLabel,
    status: scenarioStatus,
    starts_at: scenarioStartsAt,
    ends_at: scenarioEndsAt,
    scenario_id,
    promotion_id,
    promotion_name,
    promotion_active,
    is_baseline,
    offer_id,
    official_fee_source: officialFee?.source ?? null,
    marketplace: {
      sale_price_brl: priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      original_price_brl: null,
      listing_type_label: lt.label,
      sale_fee_percent: feePctStr,
      sale_fee_amount_brl: feeAmtStrResolved,
      fee_amount_brl: feeAmtStrResolved,
      shipping_cost_amount_brl: shipTrim,
      shipping_cost_source: shippingCostSource,
      shipping_context: shippingCtx,
      shipping_subsidy_amount_brl: resolvedShipping.shipping_subsidy_amount_brl,
      promotion_subsidy_amount_brl:
        pf?.promotion_subsidy_amount_brl != null ? String(pf.promotion_subsidy_amount_brl) : null,
      seller_discount_amount_brl:
        pf?.seller_discount_amount_brl != null ? String(pf.seller_discount_amount_brl) : null,
      seller_discount_percent:
        pf?.seller_discount_percent != null ? String(pf.seller_discount_percent) : null,
      promotion_source: pf?.promotion_source != null ? String(pf.promotion_source) : null,
      is_shipping_estimated: resolvedShipping.is_shipping_estimated,
      is_promotion_estimated: Boolean(pf?.is_promotion_estimated),
      marketplace_payout_amount_brl: payoutAlignedBrl ?? payoutTrim,
      net_receivable_brl: payoutAlignedBrl ?? payoutTrim,
      margin_amount_brl: marginAmt,
      margin_percent: marginPct,
    },
    subsidies: null,
    internal_costs: ic
      ? {
          product_cost_brl:
            ic.product_cost_brl != null ? String(ic.product_cost_brl) : null,
          tax_amount_brl: ic.tax_amount_brl != null ? String(ic.tax_amount_brl) : null,
          operational_packaging_total_brl:
            ic.operational_packaging_total_brl != null ? String(ic.operational_packaging_total_brl) : null,
          tax_percent_applied: ic.tax_percent_applied != null ? String(ic.tax_percent_applied) : null,
          tax_percent_label: ic.tax_percent_label != null ? String(ic.tax_percent_label) : null,
        }
      : {
          product_cost_brl: null,
          tax_amount_brl: null,
          operational_packaging_total_brl: null,
          tax_percent_applied: null,
          tax_percent_label: null,
        },
    result: res
      ? {
          profit_brl: res.profit_brl != null ? String(res.profit_brl) : null,
          margin_pct: res.margin_pct != null ? String(res.margin_pct) : null,
          break_even_price_brl: res.break_even_price_brl != null ? String(res.break_even_price_brl) : null,
          offer_status_key: res.offer_status_key != null ? String(res.offer_status_key) : null,
          offer_status_label: res.offer_status_label != null ? String(res.offer_status_label) : null,
          offer_status_semantic: res.offer_status_semantic != null ? String(res.offer_status_semantic) : null,
          offer_status_title: res.offer_status_title != null ? String(res.offer_status_title) : null,
          offer_status_subtitle: res.offer_status_subtitle != null ? String(res.offer_status_subtitle) : null,
          offer_status_message: res.offer_status_message != null ? String(res.offer_status_message) : null,
          offer_status_tooltip: res.offer_status_tooltip != null ? String(res.offer_status_tooltip) : null,
          offer_status: res.offer_status != null ? String(res.offer_status) : null,
        }
      : null,
    ui: ui
      ? {
          block2_mode: ui.block2_mode != null ? String(ui.block2_mode) : "ok",
          block3_mode: ui.block3_mode != null ? String(ui.block3_mode) : "blocked",
          block2_message: ui.block2_message != null ? String(ui.block2_message) : null,
          block3_message: ui.block3_message != null ? String(ui.block3_message) : null,
        }
      : {
          block2_mode: "ok",
          block3_mode: "blocked",
          block2_message: null,
          block3_message: null,
        },
    data_quality: {
      source: dqSource,
      warnings: warningsDedup,
    },
    sale_price_brl: priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    fee_amount_brl: feeAmtStrResolved,
    shipping_cost_brl: shipTrim,
    net_receivable_brl: payoutAlignedBrl ?? payoutTrim,
  };
}

/**
 * @param {Record<string, unknown>} baselineRow
 * @param {Record<string, unknown>} promoRow
 */
function buildSubsidyLayer(baselineRow, promoRow) {
  const b = baselineRow?.marketplace;
  const s = promoRow?.marketplace;
  if (b == null || typeof b !== "object" || s == null || typeof s !== "object") {
    return null;
  }
  const feeB = toDec(b.sale_fee_amount_brl);
  const feeS = toDec(s.sale_fee_amount_brl);
  const shipB = toDec(b.shipping_cost_amount_brl);
  const shipS = toDec(s.shipping_cost_amount_brl);
  const netB = toDec(b.marketplace_payout_amount_brl);
  const netS = toDec(s.marketplace_payout_amount_brl);
  if (feeB == null || feeS == null || netB == null || netS == null) {
    return null;
  }
  /** @type {Record<string, unknown>} */
  const out = {
    subsidy_fee_brl: decToStr2(feeB.minus(feeS)),
    subsidy_total_brl: decToStr2(netS.minus(netB)),
  };
  if (shipB != null && shipS != null) {
    out.subsidy_shipping_brl = decToStr2(shipB.minus(shipS));
  } else {
    out.subsidy_shipping_brl = null;
  }
  if (s.promotion_subsidy_amount_brl != null && String(s.promotion_subsidy_amount_brl).trim() !== "") {
    out.promotion_subsidy_ml_brl = String(s.promotion_subsidy_amount_brl).trim();
  }
  if (s.seller_discount_amount_brl != null && String(s.seller_discount_amount_brl).trim() !== "") {
    out.seller_discount_brl = String(s.seller_discount_amount_brl).trim();
  }
  return out;
}

/**
 * Precificação Inteligente — mesma engine do Raio-X (`computeOneScenario` com paridade de parâmetros).
 * Sem `pricingIntelligenceSimulate`, sem resolver paralelo de comissão, sem limpar health como PI antigo.
 *
 * @param {{
 *   listing: Record<string, unknown>;
 *   health: Record<string, unknown> | null;
 *   metrics: Record<string, unknown> | null;
 *   sellerTaxPct: string | null;
 *   salePriceStr: string;
 *   listingTypeId: string;
 *   mlAccessToken?: string | null;
 *   referenceZipCode?: string | null;
 *   itemMlId: string;
 *   listingUuid?: string | null;
 * }} p
 * @returns {Promise<{ scenario: Record<string, unknown>; engine_path: string }>}
 */
/**
 * ENGINE FINANCEIRA HOMOLOGADA — entrada PI (paridade Raio-X).
 *
 * Alterações exigem nova trilha + homologação ML.
 * Doc: docs/precificacao/PI_ENGINE_HOMOLOGADA.md
 */
export async function computeMercadoLivreScenarioComoRayxParaPI(p) {
  const {
    listing,
    health,
    metrics,
    sellerTaxPct,
    salePriceStr,
    listingTypeId,
    mlAccessToken,
    referenceZipCode,
    itemMlId,
    listingUuid,
  } = p;

  const listingForTipo = { ...listing, listing_type_id: listingTypeId };
  if (listingForTipo.raw_json != null && typeof listingForTipo.raw_json === "object") {
    listingForTipo.raw_json = {
      .../** @type {Record<string, unknown>} */ (listingForTipo.raw_json),
      listing_type_id: listingTypeId,
    };
  }

  let priceDec;
  try {
    priceDec = new Decimal(String(salePriceStr).trim().replace(",", "."));
  } catch {
    priceDec = new Decimal(NaN);
  }
  if (!priceDec.isFinite() || priceDec.lte(0)) {
    throw new Error("Preço inválido para simulação PI.");
  }
  const saleNorm = priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

  const baselinePriceStr = resolveBaselineSalePriceStr(listing, health, decStr);
  const catalogBrl = resolveMercadoLivreBaselineCatalogBrl(listing, health);
  const promos = extractPromotionScenarios(listing, health, { source: "persisted" });

  const refZip =
    referenceZipCode != null && String(referenceZipCode).trim() !== ""
      ? String(referenceZipCode).trim()
      : "01310100";

  const baseParams = {
    listing: listingForTipo,
    health,
    metrics,
    sellerTaxPct,
    mlAccessToken: mlAccessToken ?? null,
    referenceZipCode: refZip,
    itemMlId,
    listingUuid: listingUuid ?? null,
  };

  if (baselinePriceStr != null && saleNorm === baselinePriceStr) {
    const scenario = await computeOneScenario({
      ...baseParams,
      salePriceStr: baselinePriceStr,
      scenario_id: "baseline",
      promotion_id: null,
      promotion_name: null,
      promotion_status: "current",
      starts_at: null,
      ends_at: null,
      promotion_active: false,
      is_baseline: true,
      promotionFinancials: null,
    });
    return { scenario, engine_path: "rayx_baseline_match" };
  }

  for (const pr of promos) {
    const promoSale = toDec(pr.final_price_brl);
    if (promoSale == null || !promoSale.isFinite() || promoSale.lte(0)) continue;
    if (promoSale.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) !== saleNorm) continue;

    const promoId = pr.promotion_id != null ? String(pr.promotion_id).trim() : "";
    if (!promoId) continue;

    const scenarioStableId = buildMlPromotionScenarioId(promoId, pr.starts_at, pr.ends_at);
    const promoFin = resolveMercadoLivrePromotionFinancials({
      listing,
      promotionId: promoId,
      promoPriceBrl: pr.final_price_brl,
      baselineCatalogBrl: catalogBrl,
    });

    const scenario = await computeOneScenario({
      ...baseParams,
      salePriceStr: pr.final_price_brl,
      scenario_id: scenarioStableId,
      promotion_id: promoId,
      promotion_name: pr.promotion_name != null ? String(pr.promotion_name) : null,
      promotion_status: pr.status,
      starts_at: pr.starts_at,
      ends_at: pr.ends_at,
      promotion_active: pr.status === "active",
      is_baseline: false,
      promotionFinancials: promoFin,
    });
    return { scenario, engine_path: "rayx_promotion_match" };
  }

  const scenario = await computeOneScenario({
    ...baseParams,
    salePriceStr: saleNorm,
    scenario_id: listingTypeId,
    promotion_id: null,
    promotion_name: null,
    promotion_status: "current",
    starts_at: null,
    ends_at: null,
    promotion_active: false,
    is_baseline: false,
    promotionFinancials: null,
    piCustomPriceOfficialApis: true,
  });
  return { scenario, engine_path: "rayx_custom_price" };
}

/**
 * Cenário promocional somente listagem (sem motor financeiro) — price=0 sem referência calculável.
 * @param {ReturnType<typeof normalizeOfficialSellerPromotionsFromApi>["promotions"][number]} pr
 * @param {string | null} listingUuid
 * @param {string} itemMlId
 */
function buildDisplayOnlyOfficialPromotionScenarioRow(pr, listingUuid, itemMlId) {
  const scenarioStableId = buildMlPromotionScenarioId(
    pr.promotion_id,
    pr.starts_at,
    pr.ends_at,
    pr.offer_id
  );
  const lt = normalizeMercadoLivreListingType(null);
  const fin = pr.financials ?? null;
  const row = {
    key: `ml:promotion:${pr.identity_key}`,
    kind: "promotion",
    label: pr.promotion_name,
    status: pr.status,
    starts_at: pr.starts_at,
    ends_at: pr.ends_at,
    scenario_id: scenarioStableId,
    promotion_id: pr.promotion_id,
    promotion_type: pr.promotion_type,
    offer_id: pr.offer_id,
    promotion_name: pr.promotion_name,
    promotion_active: pr.promotion_active === true,
    seller_participates: pr.promotion_active === true,
    is_baseline: false,
    ml_official_identity_key: pr.identity_key,
    ml_promotion_raw_status: pr.raw_status,
    _raiox_listing_effective_api_state:
      pr.ml_effective_state === "active"
        ? "active"
        : pr.ml_effective_state === "scheduled"
          ? "scheduled"
          : "participate",
    marketplace: {
      sale_price_brl: pr.final_price_brl,
      original_price_brl: pr.reference_price_brl,
      listing_type_label: lt.label,
      sale_fee_percent: null,
      sale_fee_amount_brl: null,
      fee_amount_brl: null,
      shipping_cost_amount_brl: null,
      shipping_cost_source: null,
      shipping_context: null,
      shipping_subsidy_amount_brl: null,
      promotion_subsidy_amount_brl: fin?.promotion_subsidy_amount_brl ?? null,
      seller_discount_amount_brl: fin?.seller_discount_amount_brl ?? null,
      seller_discount_percent: fin?.seller_discount_percent ?? null,
      promotion_source: fin?.promotion_source ?? "ml_seller_promotions_api",
      is_shipping_estimated: false,
      is_promotion_estimated: true,
      marketplace_payout_amount_brl: null,
      net_receivable_brl: null,
      margin_amount_brl: null,
      margin_percent: null,
    },
    subsidies: null,
    internal_costs: {
      product_cost_brl: null,
      tax_amount_brl: null,
      operational_packaging_total_brl: null,
      tax_percent_applied: null,
      tax_percent_label: null,
    },
    result: null,
    ui: {
      block2_mode: "blocked",
      block3_mode: "blocked",
      block2_message: "Preço promocional ainda não aplicado no Mercado Livre.",
      block3_message: null,
    },
    data_quality: {
      source: "ml_api",
      price_pending: true,
      listing_id: listingUuid,
      external_listing_id: itemMlId,
    },
  };
  attachOfficialPromotionMetadata(row, pr, fin);
  logS7PiPromoFinAuditFromScenarioRow(row);
  return row;
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReturnType<typeof normalizeOfficialSellerPromotionsFromApi>["promotions"][number]} pr
 * @param {ReturnType<typeof resolveOfficialSellerPromotionFinancials> | null | undefined} promoFin
 */
function attachOfficialPromotionMetadata(row, pr, promoFin = null) {
  const fin = promoFin ?? pr.financials ?? null;
  row.ml_official_identity_key = pr.identity_key;
  row.ml_promotion_raw_status = pr.raw_status;
  row.promotion_type = pr.promotion_type;
  row.promotion_active = pr.promotion_active === true;
  row.seller_participates = pr.promotion_active === true;
  row._raiox_listing_effective_api_state =
    pr.ml_effective_state === "active"
      ? "active"
      : pr.ml_effective_state === "scheduled"
        ? "scheduled"
        : "participate";
  if (fin?.ml_financial_audit != null) {
    row.ml_financial_audit = fin.ml_financial_audit;
  }

  const rawRow =
    "ml_api_raw_row" in pr && pr.ml_api_raw_row != null && typeof pr.ml_api_raw_row === "object"
      ? /** @type {Record<string, unknown>} */ (pr.ml_api_raw_row)
      : /** @type {Record<string, unknown>} */ ({});

  logS7PromotionsPiAudit("financial_raw_fields", {
    listing_external_id: row.external_listing_id ?? pr.reference_price_brl ?? null,
    ...extractOfficialPromotionFinancialRawFields(rawRow),
  });

  if (row.marketplace != null && typeof row.marketplace === "object" && fin != null) {
    const m = /** @type {Record<string, unknown>} */ (row.marketplace);
    if (pr.reference_price_brl != null) m.original_price_brl = pr.reference_price_brl;
    if (fin.seller_discount_amount_brl != null) m.seller_discount_amount_brl = fin.seller_discount_amount_brl;
    if (fin.seller_discount_percent_display != null) {
      m.seller_discount_percent = `${fin.seller_discount_percent_display}.00`;
    } else if (fin.seller_discount_percent != null) {
      m.seller_discount_percent = fin.seller_discount_percent;
    }
    if (
      fin.ml_financial_audit != null &&
      typeof fin.ml_financial_audit === "object" &&
      /** @type {Record<string, unknown>} */ (fin.ml_financial_audit).original_price != null
    ) {
      m.original_price_brl = String(/** @type {Record<string, unknown>} */ (fin.ml_financial_audit).original_price);
    }
    m.promotion_source = fin.promotion_source ?? "ml_seller_promotions_api";
    if (pr.price_applied === false) m.is_promotion_estimated = true;

    const presentation = resolveOfficialPromotionPresentationFinancials({
      grossFeeBrl:
        m.sale_fee_amount_brl != null
          ? String(m.sale_fee_amount_brl)
          : m.fee_amount_brl != null
            ? String(m.fee_amount_brl)
            : null,
      salePriceBrl: m.sale_price_brl != null ? String(m.sale_price_brl) : null,
      shippingCostBrl: m.shipping_cost_amount_brl != null ? String(m.shipping_cost_amount_brl) : null,
      fin,
      rawRow,
    });

    logS7PromotionsPiAudit("financial_normalized", {
      listing_external_id: row.external_listing_id ?? null,
      promotion_id: row.promotion_id ?? null,
      promotion_name: row.promotion_name ?? null,
      ...presentation,
    });

    if (presentation.gross_fee_brl != null) {
      m.fee_amount_before_promo_subsidy_brl = presentation.gross_fee_brl;
    }
    if (presentation.net_fee_brl != null) {
      m.fee_amount_after_promo_subsidy_brl = presentation.net_fee_brl;
    }
    if (presentation.fee_discount_brl != null) {
      m.promotion_subsidy_amount_brl = presentation.fee_discount_brl;
      m.fee_discount_brl = presentation.fee_discount_brl;
      m.charged_fee_discount_brl = presentation.fee_discount_brl;
      m.marketplace_fee_discount_amount_brl = presentation.fee_discount_brl;
    }
    if (presentation.expected_payout_brl != null) {
      m.payout_before_promo_subsidy_brl =
        presentation.gross_fee_brl != null &&
        presentation.sale_price_brl != null &&
        presentation.shipping_cost_brl != null
          ? decToStr2(
              toDec(presentation.sale_price_brl)
                .minus(toDec(presentation.gross_fee_brl))
                .minus(toDec(presentation.shipping_cost_brl))
            )
          : null;
      m.payout_after_promo_subsidy_brl = presentation.expected_payout_brl;
      m.marketplace_payout_amount_brl = presentation.expected_payout_brl;
      m.net_receivable_brl = presentation.expected_payout_brl;
      row.net_receivable_brl = presentation.expected_payout_brl;
      row.marketplace_payout_amount_brl = presentation.expected_payout_brl;
    }
  }
  if (fin != null) {
    logS7PiPromoFinAuditDeep(row, fin, /** @type {Record<string, unknown>} */ (row.marketplace ?? {}));
    logS7PiPromoFlowAudit("backend_after_attachOfficialPromotionMetadata", {
      ...buildPiPromoFlowAuditPayload({
        promotion_name: row.promotion_name != null ? String(row.promotion_name) : null,
        promotion_id: row.promotion_id != null ? String(row.promotion_id) : null,
        type: row.promotion_type != null ? String(row.promotion_type) : null,
        ref_id: row.offer_id != null ? String(row.offer_id) : null,
        fin,
        row,
        marketplace: /** @type {Record<string, unknown>} */ (row.marketplace ?? {}),
        source_field_used: "attachOfficialPromotionMetadata",
      }),
    });
  }
  return row;
}

/** @param {Record<string, unknown>} row */
function logS7PiPromoFinAuditFromScenarioRow(row) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PI_PROMO_FIN_AUDIT !== "1") return;
  const m =
    row.marketplace != null && typeof row.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (row.marketplace)
      : /** @type {Record<string, unknown>} */ ({});
  const audit =
    row.ml_financial_audit != null && typeof row.ml_financial_audit === "object"
      ? /** @type {Record<string, unknown>} */ (row.ml_financial_audit)
      : /** @type {Record<string, unknown>} */ ({});
  const mlDisc = audit.ml_discount_brl != null ? String(audit.ml_discount_brl) : null;
  const suse7Disc = m.seller_discount_amount_brl != null ? String(m.seller_discount_amount_brl) : null;
  const mlPct = audit.ml_discount_pct != null ? String(audit.ml_discount_pct) : null;
  const suse7Pct = m.seller_discount_percent != null ? String(m.seller_discount_percent) : null;
  console.info("[S7_PI_PROMO_FIN_AUDIT]", {
    promotion_name: row.promotion_name ?? row.label ?? null,
    promotion_id: row.promotion_id ?? null,
    type: row.promotion_type ?? null,
    ref_id: row.offer_id ?? null,
    raw_status: row.ml_promotion_raw_status ?? null,
    original_price: audit.original_price ?? m.original_price_brl ?? null,
    promotion_price: audit.promotion_price ?? m.sale_price_brl ?? null,
    ml_discount_brl: mlDisc,
    ml_discount_pct: mlPct,
    suse7_discount_brl: suse7Disc,
    suse7_discount_pct: suse7Pct,
    ml_fee_brl: null,
    suse7_fee_brl: m.sale_fee_amount_brl ?? m.fee_amount_brl ?? null,
    ml_shipping_brl: null,
    suse7_shipping_brl: m.shipping_cost_amount_brl ?? null,
    ml_payout_brl: null,
    suse7_payout_brl: m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? null,
    diff_discount_brl:
      mlDisc != null && suse7Disc != null && toDec(mlDisc) != null && toDec(suse7Disc) != null
        ? decToStr2(toDec(suse7Disc).minus(toDec(mlDisc)))
        : null,
    diff_discount_pct:
      mlPct != null && suse7Pct != null && toDec(mlPct) != null && toDec(suse7Pct) != null
        ? decToStr2(toDec(suse7Pct).minus(toDec(mlPct)))
        : null,
    diff_payout_brl: null,
    discount_source: audit.discount_source ?? null,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   listingId?: string;
 *   listingExternalId?: string;
 *   scenarioScope?: string;
 *   mlAccessToken?: string | null;
 *   referenceZipCode?: string | null;
 * }} keys
 */
export async function buildMercadoLivreListingPricingScenariosPayload(supabase, userId, keys) {
  const listingId = keys.listingId != null ? String(keys.listingId).trim() : "";
  const listingExternalId = keys.listingExternalId != null ? String(keys.listingExternalId).trim() : "";
  const scenarioScope =
    keys.scenarioScope != null && String(keys.scenarioScope).trim() !== ""
      ? String(keys.scenarioScope).trim().toLowerCase()
      : "";
  const wantPricingOpportunities = scenarioScope === "pricing_opportunities";

  let loaded;
  if (listingId) {
    loaded = await loadMercadoLivreListingPricingInputs(supabase, userId, listingId);
  } else if (listingExternalId) {
    loaded = await loadMercadoLivreListingPricingInputsByExternalId(supabase, userId, listingExternalId);
  } else {
    return { ok: false, error: "Informe listingId ou listingExternalId.", status: 400 };
  }

  if (!loaded.ok || !loaded.listing) {
    return { ok: false, error: loaded.error ?? "Falha ao carregar anúncio.", status: loaded.status ?? 500 };
  }

  const { listing, health, metrics, sellerTaxPct, external_listing_id } = loaded;
  const marketplaceAccountId =
    loaded.marketplace_account_id != null && String(loaded.marketplace_account_id).trim() !== ""
      ? String(loaded.marketplace_account_id).trim()
      : listing.marketplace_account_id != null && String(listing.marketplace_account_id).trim() !== ""
        ? String(listing.marketplace_account_id).trim()
        : null;
  const sellerId =
    loaded.seller_id != null && String(loaded.seller_id).trim() !== ""
      ? String(loaded.seller_id).trim()
      : null;

  const baselinePriceStr = resolveBaselineSalePriceStr(listing, health, decStr);
  if (baselinePriceStr == null) {
    return {
      ok: false,
      error: "Não foi possível determinar o preço base (sem promoção) do anúncio.",
      status: 422,
    };
  }

  const catalogBrl = resolveMercadoLivreBaselineCatalogBrl(listing, health);

  const persistedPromos = extractPromotionScenarios(listing, health, { source: "persisted" });
  /** @type {ReturnType<typeof normalizeOfficialSellerPromotionsFromApi>["promotions"] | ReturnType<typeof extractPromotionScenarios>} */
  let promos = persistedPromos;
  /** @type {Record<string, unknown>[]} */
  let rawLivePromotions = [];
  let mlEndpointUsed = null;
  let liveFetchOk = false;
  let liveFetchHttpStatus = /** @type {number | null} */ (null);
  let liveFetchError = /** @type {string | null} */ (null);
  let officialNormalize = null;
  /** @type {string[]} */
  const normalizationRemovalReasons = [];
  const diag = {
    persisted_promos: persistedPromos.length,
    live_promos: 0,
    discarded_invalid: 0,
    discarded_ended: 0,
    discarded_expired: 0,
    used_live_enrichment: false,
    dropped_as_duplicate: 0,
  };

  let mlToken = keys.mlAccessToken ?? null;
  let mlTokenSource = mlToken ? "handler_fallback" : null;

  const refZip =
    keys.referenceZipCode != null && String(keys.referenceZipCode).trim() !== ""
      ? String(keys.referenceZipCode).trim()
      : "01310100";

  const itemMlId =
    external_listing_id != null && String(external_listing_id).trim() !== ""
      ? String(external_listing_id).trim()
      : listing.external_listing_id != null
        ? String(listing.external_listing_id).trim()
        : listingExternalId || "";
  const listingUuid = listing.id != null ? String(listing.id) : null;

  if (marketplaceAccountId) {
    try {
      mlToken = await getValidMLToken(userId, { marketplaceAccountId });
      mlTokenSource = "listing_marketplace_account";
    } catch (e) {
      if (!mlToken && sellerId) {
        try {
          mlToken = await getValidMLToken(userId, { mlUserId: sellerId });
          mlTokenSource = "listing_seller_id";
        } catch {
          // tenta fallback abaixo
        }
      }
      if (!mlToken) {
        logS7PromotionsPiAudit("request", {
          user_id: userId,
          marketplace_account_id: marketplaceAccountId,
          seller_id: sellerId,
          listing_external_id: itemMlId || null,
          endpoint: `GET /seller-promotions/items/${itemMlId || "{item}"}?app_version=v2`,
          token_error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } else if (!mlToken) {
    try {
      mlToken = await getValidMLToken(userId);
      mlTokenSource = "user_default";
    } catch (e) {
      logS7PromotionsPiAudit("request", {
        user_id: userId,
        marketplace_account_id: null,
        seller_id: sellerId,
        listing_external_id: itemMlId || null,
        endpoint: `GET /seller-promotions/items/${itemMlId || "{item}"}?app_version=v2`,
        token_error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const debugPromotionScenario = shouldEmitPromotionDebug(itemMlId);

  logS7MlPromosAudit("listing_id", itemMlId || listingUuid || null);
  logS7MlPromosAudit("scenario_scope", scenarioScope || null);

  const shouldFetchLiveSellerPromotions =
    Boolean(mlToken && itemMlId) && (wantPricingOpportunities || persistedPromos.length <= 1);

  /** @type {Map<string, Record<string, unknown>>} */
  const rawRowByIdentity = new Map();

  if (shouldFetchLiveSellerPromotions) {
    mlEndpointUsed = `GET /seller-promotions/items/${itemMlId}?app_version=v2`;
    logS7PromotionsPiAudit("request", {
      user_id: userId,
      marketplace_account_id: marketplaceAccountId,
      seller_id: sellerId,
      listing_external_id: itemMlId,
      endpoint: mlEndpointUsed,
      token_source: mlTokenSource,
    });
    try {
      const fetchResult = await fetchSellerPromotionsByItemDetailed(mlToken, itemMlId);
      liveFetchOk = fetchResult.ok;
      liveFetchHttpStatus = fetchResult.httpStatus;
      liveFetchError = fetchResult.error;
      rawLivePromotions = fetchResult.rows;

      logS7PromotionsPiAudit("raw_response_summary", {
        listing_external_id: itemMlId,
        raw_count: rawLivePromotions.length,
        response_keys: fetchResult.responseKeys,
        http_status: liveFetchHttpStatus,
        fetch_error: liveFetchError,
      });

      for (const raw of rawLivePromotions) {
        if (!raw || typeof raw !== "object") continue;
        const key = buildOfficialSellerPromotionIdentityKey(/** @type {Record<string, unknown>} */ (raw));
        if (key.replace(/\|/g, "") !== "") {
          rawRowByIdentity.set(key, /** @type {Record<string, unknown>} */ (raw));
        }
        const nameRaw = raw.name ?? raw.promotion_name ?? raw.type;
        if (
          nameRaw != null &&
          String(nameRaw).toLowerCase().includes("aumente") &&
          String(nameRaw).toLowerCase().includes("vendas")
        ) {
          logS7PiPromoFlowAudit("backend_after_seller_promotions_fetch", {
            ...buildPiPromoFlowAuditPayload({
              promotion_name: String(nameRaw),
              promotion_id: raw.id ?? raw.promotion_id ?? null,
              type: raw.type ?? raw.promotion_type ?? null,
              ref_id: raw.ref_id ?? raw.offer_id ?? null,
              fin: resolveOfficialSellerPromotionFinancials(
                /** @type {Record<string, unknown>} */ (raw),
                raw.price != null ? String(raw.price) : null,
                catalogBrl
              ),
              row: /** @type {Record<string, unknown>} */ (raw),
              source_field_used: "ml_seller_promotions_api_raw_row",
            }),
            seller_percentage_raw: raw.seller_percentage ?? null,
            meli_percentage_raw: raw.meli_percentage ?? null,
            discount_meli_boost_amount_raw: raw.discount_meli_boost_amount ?? null,
            original_price_raw: raw.original_price ?? null,
            price_raw: raw.price ?? null,
          });
        }
      }
      officialNormalize = normalizeOfficialSellerPromotionsFromApi(rawLivePromotions, { source: "live" });
      diag.live_promos = officialNormalize.normalized_total;
      diag.dropped_as_duplicate = officialNormalize.dropped_as_duplicate;
      diag.used_live_enrichment = liveFetchOk && rawLivePromotions.length > 0;

      if (wantPricingOpportunities && liveFetchOk) {
        // Fonte soberana: endpoint oficial por item — sem somar persistido/prices[].
        promos = officialNormalize.promotions;
      } else if (wantPricingOpportunities) {
        promos = persistedPromos.length > 0 ? persistedPromos : [];
        normalizationRemovalReasons.push(
          `live_fetch_failed:${liveFetchHttpStatus ?? "unknown"}:${liveFetchError ?? "unknown"}`
        );
      } else if (persistedPromos.length <= 1) {
        promos =
          officialNormalize.normalized_total > 0 ? officialNormalize.promotions : persistedPromos;
      }

      logS7PromotionsPiAudit("normalization", {
        raw_count: rawLivePromotions.length,
        normalized_count: officialNormalize.normalized_total,
        removidos_por_filtro: officialNormalize.dropped_as_duplicate,
        motivos_de_remocao:
          normalizationRemovalReasons.length > 0
            ? normalizationRemovalReasons
            : liveFetchOk
              ? []
              : [`live_fetch_failed:${liveFetchHttpStatus ?? "unknown"}:${liveFetchError ?? "unknown"}`],
      });
    } catch (e) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.PRICING_FALLBACK_APPLIED, {
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        external_listing_id: itemMlId,
        reason: "live_item_promotion_fetch_failed",
        message: e instanceof Error ? e.message : String(e),
      });
      if (wantPricingOpportunities) {
        promos = persistedPromos.length > 0 ? persistedPromos : [];
        normalizationRemovalReasons.push(
          `live_fetch_exception:${e instanceof Error ? e.message : String(e)}`
        );
        logS7PromotionsPiAudit("normalization", {
          raw_count: 0,
          normalized_count: promos.length,
          removidos_por_filtro: 0,
          motivos_de_remocao: normalizationRemovalReasons,
        });
      }
    }
  } else if (wantPricingOpportunities && !mlToken) {
    logS7PromotionsPiAudit("request", {
      user_id: userId,
      marketplace_account_id: marketplaceAccountId,
      seller_id: sellerId,
      listing_external_id: itemMlId || null,
      endpoint: `GET /seller-promotions/items/${itemMlId || "{item}"}?app_version=v2`,
      token_error: "missing_access_token",
    });
    promos = persistedPromos;
    logS7PromotionsPiAudit("normalization", {
      raw_count: 0,
      normalized_count: promos.length,
      removidos_por_filtro: 0,
      motivos_de_remocao: ["missing_access_token"],
    });
  }

  logS7MlPromosAudit("ml_endpoint_used", mlEndpointUsed);
  logS7MlPromosAudit("live_total", liveFetchOk ? rawLivePromotions.length : null);
  logS7MlPromosAudit(
    "live_identity_keys",
    officialNormalize != null
      ? officialNormalize.identity_keys
      : rawLivePromotions.map((row) => buildOfficialSellerPromotionIdentityKey(row))
  );
  logS7MlPromosAudit(
    "normalized_total",
    officialNormalize != null ? officialNormalize.normalized_total : promos.length
  );
  logS7MlPromosAudit("dropped_as_duplicate", diag.dropped_as_duplicate);
  logS7MlPromosAudit(
    "status_counts",
    officialNormalize != null ? officialNormalize.status_counts : null
  );

  let baseline;
  try {
    baseline = await computeOneScenario({
      listing,
      health,
      metrics,
      sellerTaxPct,
      salePriceStr: baselinePriceStr,
      scenario_id: "baseline",
      promotion_id: null,
      promotion_name: null,
      promotion_status: "current",
      starts_at: null,
      ends_at: null,
      promotion_active: false,
      is_baseline: true,
      mlAccessToken: mlToken,
      referenceZipCode: refZip,
      itemMlId,
      listingUuid,
      promotionFinancials: null,
    });
  } catch (e) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PRICING_SCENARIOS_PIPELINE_ERROR, {
      marketplace: "mercado_livre",
      listing_id: listingUuid,
      external_listing_id: itemMlId,
      phase: "baseline_scenario",
      reason: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      error: "Não foi possível montar os cenários de precificação. Tente novamente ou sincronize o anúncio.",
      status: 500,
    };
  }

  {
    const { logPricingFlowDiff, extrairMetricasFluxoPrecificacao } = await import(
      "./pricingFlowDiffLog.js"
    );
    const m = extrairMetricasFluxoPrecificacao(baseline);
    logPricingFlowDiff({
      flow: "rayx",
      handler: "POST /api/ml/listings/pricing-scenarios",
      listingExternalId: itemMlId || listingExternalId || null,
      sale_price: baselinePriceStr,
      listing_type:
        listing.listing_type_id != null ? String(listing.listing_type_id) : null,
      has_marketplace_account: Boolean(mlToken),
      has_access_token: Boolean(mlToken),
      token_source: mlTokenSource,
      calls_listing_prices: Boolean(mlToken && itemMlId),
      listing_prices_status: m.fee_amount_brl != null ? "resolved" : "unresolved",
      fee_amount_brl: m.fee_amount_brl,
      fee_source: m.fee_source,
      shipping_cost_brl: m.shipping_cost_brl,
      shipping_source: m.shipping_source,
      payout_brl: m.payout_brl,
      warnings: m.warnings,
      engine_path: "rayx_baseline",
    });
  }

  /** @type {Record<string, unknown>[]} */
  const promotionRowsRaw = [];
  /** @type {Record<string, unknown>[]} */
  const promotionDebugRows = [];
  if (debugPromotionScenario) {
    const selectedFingerprints = new Set(
      promos.map((p) => {
        const identity =
          "identity_key" in p && p.identity_key != null
            ? String(p.identity_key)
            : promotionExtractionMapKey(/** @type {Parameters<typeof promotionExtractionMapKey>[0]} */ (p));
        return identity;
      })
    );
    const baseCandidates = [
      ...persistedPromos.map((p) => ({ p, fallbackReason: "superseded_by_live_official" })),
      ...(officialNormalize != null
        ? officialNormalize.promotions.map((p) => ({ p, fallbackReason: "not_selected_for_pipeline" }))
        : []),
    ];
    for (const { p, fallbackReason } of baseCandidates) {
      const identity =
        "identity_key" in p && p.identity_key != null
          ? String(p.identity_key)
          : promotionExtractionMapKey(/** @type {Parameters<typeof promotionExtractionMapKey>[0]} */ (p));
      if (selectedFingerprints.has(identity)) continue;
      const pid = p.promotion_id != null ? String(p.promotion_id).trim() : "";
      promotionDebugRows.push({
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        external_listing_id: itemMlId,
        source: p.source != null ? String(p.source) : "persisted",
        promotion_id: pid || null,
        scenario_id: buildMlPromotionScenarioId(pid, p.starts_at, p.ends_at, p.offer_id ?? null),
        label: p.promotion_name ?? null,
        raw_status: p.raw_status ?? null,
        normalized_status: p.status ?? "unknown",
        starts_at: p.starts_at ?? null,
        ends_at: p.ends_at ?? null,
        sale_price_brl: p.final_price_brl ?? null,
        discard_reason: fallbackReason,
        included_in_final: false,
      });
    }
  }
  for (const pr of promos) {
    const isOfficial =
      wantPricingOpportunities &&
      (("identity_key" in pr && pr.identity_key != null) || pr.source === "live" || rawRowByIdentity.size > 0);
    const promoSource = pr.source != null ? String(pr.source) : "persisted";
    const rawStatus = pr.raw_status != null ? String(pr.raw_status) : null;
    const normalizedStatus = pr.status != null ? String(pr.status) : "unknown";
    const promoId = pr.promotion_id != null ? String(pr.promotion_id).trim() : "";
    const offerId = pr.offer_id != null ? String(pr.offer_id).trim() : "";
    const scenarioStableId = buildMlPromotionScenarioId(promoId, pr.starts_at, pr.ends_at, offerId || null);
    const promoSale = pr.final_price_brl != null ? toDec(pr.final_price_brl) : null;
    const debugBase = {
      marketplace: "mercado_livre",
      listing_id: listingUuid,
      external_listing_id: itemMlId,
      source: promoSource,
      promotion_id: promoId || null,
      scenario_id: scenarioStableId,
      label: pr.promotion_name ?? null,
      raw_status: rawStatus,
      normalized_status: normalizedStatus,
      starts_at: pr.starts_at ?? null,
      ends_at: pr.ends_at ?? null,
      sale_price_brl: pr.final_price_brl ?? null,
    };
    const eligibility = isOfficial
      ? evaluateOfficialPromotionUiEligibility({ raw_status: pr.raw_status, ends_at: pr.ends_at })
      : evaluatePromotionUiEligibility({ status: pr.status, ends_at: pr.ends_at });
    if (!eligibility.ok) {
      if (eligibility.reason === "expired") diag.discarded_expired += 1;
      else diag.discarded_ended += 1;
      normalizationRemovalReasons.push(
        `${promoId || pr.promotion_name || "unknown"}:${eligibility.reason ?? "ineligible"}`
      );
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_PROMOTION_SCENARIO_SKIPPED_INVALID, {
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        promotion_id: pr.promotion_id ?? null,
        reason: eligibility.reason,
        promotion_status: pr.status ?? null,
        ends_at: pr.ends_at ?? null,
      });
      if (debugPromotionScenario)
        promotionDebugRows.push({
          ...debugBase,
          discard_reason: eligibility.reason,
          included_in_final: false,
        });
      continue;
    }
    if (!promoId) {
      diag.discarded_invalid += 1;
      normalizationRemovalReasons.push(`${pr.promotion_name || "unknown"}:missing_promotion_id`);
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PROMOTION_SCENARIO_SKIPPED_INVALID, {
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        promotion_id: null,
        reason: "missing_promotion_id",
      });
      if (debugPromotionScenario)
        promotionDebugRows.push({
          ...debugBase,
          discard_reason: "missing_promotion_id",
          included_in_final: false,
        });
      continue;
    }

    const promotionActive = isOfficial
      ? pr.promotion_active === true
      : String(pr.raw_status ?? pr.status ?? "")
          .trim()
          .toLowerCase() === "started" || pr.status === "active";

    if (promoSale == null || !promoSale.isFinite() || promoSale.lte(0)) {
      if (isOfficial) {
        const displayRow = buildDisplayOnlyOfficialPromotionScenarioRow(
          /** @type {ReturnType<typeof normalizeOfficialSellerPromotionsFromApi>["promotions"][number]} */ (pr),
          listingUuid,
          itemMlId
        );
        promotionRowsRaw.push(displayRow);
        if (debugPromotionScenario)
          promotionDebugRows.push({
            ...debugBase,
            discard_reason: null,
            included_in_final: null,
          });
        continue;
      }
      diag.discarded_invalid += 1;
      if (debugPromotionScenario)
        promotionDebugRows.push({
          ...debugBase,
          discard_reason: "invalid_sale_price_brl",
          included_in_final: false,
        });
      continue;
    }

    try {
      /** @type {ReturnType<typeof resolveOfficialSellerPromotionFinancials> | ReturnType<typeof resolveMercadoLivrePromotionFinancials>} */
      let promoFin;
      let promoFinSource = "legacy_resolver";
      if (isOfficial) {
        const identityKey =
          "identity_key" in pr && pr.identity_key != null ? String(pr.identity_key) : buildOfficialSellerPromotionIdentityKey(
              /** @type {Record<string, unknown>} */ (
                "ml_api_raw_row" in pr && pr.ml_api_raw_row != null && typeof pr.ml_api_raw_row === "object"
                  ? pr.ml_api_raw_row
                  : /** @type {Record<string, unknown>} */ ({ id: pr.promotion_id, type: pr.promotion_type, ref_id: pr.offer_id })
              )
            );
        const rawRow =
          rawRowByIdentity.get(identityKey) ??
          ("ml_api_raw_row" in pr && pr.ml_api_raw_row != null && typeof pr.ml_api_raw_row === "object"
            ? /** @type {Record<string, unknown>} */ (pr.ml_api_raw_row)
            : null);
        if (rawRow != null) {
          promoFin = resolveOfficialSellerPromotionFinancials(
            rawRow,
            pr.final_price_brl,
            catalogBrl ?? pr.reference_price_brl
          );
          promoFinSource = "ml_seller_promotions_api_raw_row";
        } else {
          promoFin = resolveOfficialSellerPromotionFinancials(
            /** @type {Record<string, unknown>} */ ({
              id: pr.promotion_id,
              type: pr.promotion_type,
              ref_id: pr.offer_id,
              name: pr.promotion_name,
              price: pr.final_price_brl,
              original_price: pr.reference_price_brl,
            }),
            pr.final_price_brl,
            catalogBrl ?? pr.reference_price_brl
          );
          promoFinSource = "official_sparse_row";
        }
        logS7PiPromoFlowAudit("backend_after_resolveOfficialSellerPromotionFinancials", {
          ...buildPiPromoFlowAuditPayload({
            promotion_name: pr.promotion_name != null ? String(pr.promotion_name) : null,
            promotion_id: promoId || null,
            type: pr.promotion_type != null ? String(pr.promotion_type) : null,
            ref_id: offerId || null,
            fin: promoFin,
            source_field_used: promoFinSource,
          }),
          is_official: isOfficial,
        });
      } else {
        promoFin = resolveMercadoLivrePromotionFinancials({
          listing,
          promotionId: promoId,
          promoPriceBrl: pr.final_price_brl,
          baselineCatalogBrl:
            isOfficial && pr.reference_price_brl != null ? pr.reference_price_brl : catalogBrl,
        });
        promoFinSource = "resolveMercadoLivrePromotionFinancials";
      }
      const row = await computeOneScenario({
        listing,
        health,
        metrics,
        sellerTaxPct,
        salePriceStr: pr.final_price_brl,
        scenario_id: scenarioStableId,
        promotion_id: promoId,
        promotion_name: pr.promotion_name != null ? String(pr.promotion_name) : null,
        promotion_status: pr.status,
        starts_at: pr.starts_at,
        ends_at: pr.ends_at,
        promotion_active: promotionActive,
        is_baseline: false,
        mlAccessToken: mlToken,
        referenceZipCode: refZip,
        itemMlId,
        listingUuid,
        offer_id: offerId || null,
        promotionFinancials: promoFin,
      });
      if (isOfficial) {
        attachOfficialPromotionMetadata(
          row,
          /** @type {ReturnType<typeof normalizeOfficialSellerPromotionsFromApi>["promotions"][number]} */ (pr),
          promoFin
        );
        logS7PiPromoFinAuditFromScenarioRow(row);
      } else {
        row.ml_promotion_raw_status = rawStatus;
        row.promotion_active = promotionActive;
        row.seller_participates = promotionActive;
      }
      const sub = buildSubsidyLayer(baseline, row);
      row.subsidies = sub;
      promotionRowsRaw.push(row);
      if (debugPromotionScenario)
        promotionDebugRows.push({
          ...debugBase,
          discard_reason: null,
          included_in_final: null,
        });
    } catch (e) {
      diag.discarded_invalid += 1;
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PRICING_SCENARIOS_PIPELINE_ERROR, {
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        external_listing_id: itemMlId,
        promotion_id: promoId || null,
        label: pr.promotion_name ?? null,
        starts_at: pr.starts_at ?? null,
        ends_at: pr.ends_at ?? null,
        sale_price_brl: pr.final_price_brl ?? null,
        reason: e instanceof Error ? e.message : String(e),
      });
      if (debugPromotionScenario)
        promotionDebugRows.push({
          ...debugBase,
          discard_reason: "pipeline_error",
          included_in_final: false,
        });
    }
  }

  const promotionScenarios = dedupePromotionScenarioRows(promotionRowsRaw, listingUuid, diag);
  logS7MlPromosAudit("deduped_total", promotionScenarios.length);
  logS7MlPromosAudit("final_response_total", promotionScenarios.length);
  /** @type {Record<string, unknown>[]} */
  let allScenarios;
  try {
    allScenarios = [baseline, ...promotionScenarios].sort(compareScenarioContractRows);
  } catch (e) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PRICING_SCENARIOS_PIPELINE_ERROR, {
      marketplace: "mercado_livre",
      listing_id: listingUuid,
      phase: "sort_all_scenarios",
      reason: e instanceof Error ? e.message : String(e),
    });
    allScenarios = [baseline, ...promotionScenarios];
  }
  if (debugPromotionScenario && promotionDebugRows.length > 0) {
    const finalScenarioIds = new Set(
      promotionScenarios
        .map((s) => (s?.scenario_id != null ? String(s.scenario_id).trim() : ""))
        .filter(Boolean)
    );
    for (const row of promotionDebugRows) {
      const sid =
        row.scenario_id != null && String(row.scenario_id).trim() !== ""
          ? String(row.scenario_id).trim()
          : row.promotion_id != null
            ? String(row.promotion_id).trim()
            : "";
      const alreadyDiscarded =
        row.discard_reason != null && String(row.discard_reason).trim() !== "";
      const included = alreadyDiscarded ? false : sid !== "" && finalScenarioIds.has(sid);
      const discardReason = alreadyDiscarded
        ? row.discard_reason
        : included
          ? null
          : "dedupe";
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_PROMOTION_SCENARIO_DEBUG, {
        ...row,
        discard_reason: discardReason,
        included_in_final: included,
      });
    }
  }

  logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_PROMOTION_SCENARIOS_DIAGNOSTIC, {
    marketplace: "mercado_livre",
    listing_id: listingUuid,
    persisted_promos: diag.persisted_promos,
    live_promos: diag.live_promos,
    final_promos: promotionScenarios.length,
    discarded_invalid: diag.discarded_invalid,
    discarded_ended: diag.discarded_ended,
    discarded_expired: diag.discarded_expired,
    used_live_enrichment: diag.used_live_enrichment,
  });

  for (const promoRow of promotionScenarios) {
    if (!promoRow || typeof promoRow !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (promoRow);
    const name = r.promotion_name != null ? String(r.promotion_name) : "";
    if (!name.toLowerCase().includes("aumente") || !name.toLowerCase().includes("vendas")) continue;
    logS7PiPromoFlowAudit("backend_pricing_scenarios_response", {
      ...buildPiPromoFlowAuditPayload({
        promotion_name: name,
        promotion_id: r.promotion_id != null ? String(r.promotion_id) : null,
        type: r.promotion_type != null ? String(r.promotion_type) : null,
        ref_id: r.offer_id != null ? String(r.offer_id) : null,
        row: r,
        marketplace:
          r.marketplace != null && typeof r.marketplace === "object"
            ? /** @type {Record<string, unknown>} */ (r.marketplace)
            : {},
        source_field_used: "promotion_scenarios_response",
      }),
    });
  }

  logS7PromotionsPiAudit("final_payload", {
    listing_external_id: itemMlId || listingExternalId || null,
    promotions_count: promotionScenarios.length,
    promotion_names: promotionScenarios
      .map((s) => (s?.promotion_name != null ? String(s.promotion_name) : null))
      .filter(Boolean),
    statuses: promotionScenarios.map((s) => {
      if (!s || typeof s !== "object") return null;
      const r = /** @type {Record<string, unknown>} */ (s);
      return r.ml_promotion_raw_status ?? r.status ?? null;
    }),
    pipeline: {
      persisted_promos: diag.persisted_promos,
      live_promos: diag.live_promos,
      live_fetch_ok: liveFetchOk,
      live_http_status: liveFetchHttpStatus,
      token_source: mlTokenSource,
      marketplace_account_id: marketplaceAccountId,
      seller_id: sellerId,
      discarded_invalid: diag.discarded_invalid,
      discarded_expired: diag.discarded_expired,
      filter_reasons: normalizationRemovalReasons,
    },
  });

  return {
    ok: true,
    data: {
      // Contrato principal: `scenarios` (baseline + promoções).
      // `baseline` = atalho de conveniência; `promotion_scenarios` = compat transitória.
      listing_id: itemMlId || "",
      listing_external_id: external_listing_id || "",
      scenarios: allScenarios,
      promotion_scenarios: promotionScenarios,
      baseline,
      promotions_pipeline: {
        live_fetch_ok: liveFetchOk,
        live_http_status: liveFetchHttpStatus,
        live_fetch_error: liveFetchError,
        persisted_count: diag.persisted_promos,
        live_normalized_count: diag.live_promos,
        final_count: promotionScenarios.length,
        token_source: mlTokenSource,
        marketplace_account_id: marketplaceAccountId,
        seller_id: sellerId,
        warnings:
          wantPricingOpportunities && !liveFetchOk && promotionScenarios.length === 0
            ? [
                liveFetchError != null
                  ? `live_seller_promotions_fetch_failed:${liveFetchError}`
                  : "live_seller_promotions_unavailable",
              ]
            : [],
      },
    },
  };
}
