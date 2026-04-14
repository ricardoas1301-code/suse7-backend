// ======================================================
// Cenários de precificação ML — baseline + todas as promoções (ativas/programadas/demais).
// Cada cenário: listing com preço isolado + health sem ancoragem cruzada de repasse/tarifa/frete.
// ======================================================

import Decimal from "decimal.js";
import {
  fetchItem,
  fetchSellerPromotionsByItem,
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
  resolveMercadoLivreBaselineCatalogBrl,
  resolveMercadoLivrePromotionFinancials,
} from "./strategies/mercadoLivrePromotionResolverStrategy.js";

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
    shipping_cost: null,
    shipping_cost_amount: null,
  };
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Decimal} priceDec
 */
function listingWithSalePrice(listing, priceDec) {
  const s = priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return { ...listing, price: s };
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
    normalizedRaw === "candidate"
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
function buildMlPromotionScenarioId(promId, startsAt, endsAt) {
  const pid = promId != null && String(promId).trim() !== "" ? String(promId).trim() : "";
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
 * }} candidate
 */
function promotionExtractionMapKey(candidate) {
  let pid = "";
  let s = "";
  let e = "";
  let sale = "";
  try {
    pid = candidate.promotion_id != null ? String(candidate.promotion_id).trim() : "";
    s = candidate.starts_at != null ? String(candidate.starts_at).trim() : "";
    e = candidate.ends_at != null ? String(candidate.ends_at).trim() : "";
    sale = candidate.final_price_brl != null ? String(candidate.final_price_brl).trim() : "";
  } catch {
    pid = "";
    s = "";
    e = "";
    sale = "";
  }
  return `${pid}|${s}|${e}|${sale}`;
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
    const pid = row.promotion_id != null ? String(row.promotion_id).trim() : "";
    const starts = row.starts_at != null ? String(row.starts_at).trim() : "";
    const ends = row.ends_at != null ? String(row.ends_at).trim() : "";
    if (pid !== "") {
      return `promotion_id:${pid}|${starts}|${ends}`;
    }
    const label =
      row.label != null && String(row.label).trim() !== ""
        ? String(row.label).trim()
        : row.promotion_name != null
          ? String(row.promotion_name).trim()
          : "";
    const sale =
      row.sale_price_brl != null && String(row.sale_price_brl).trim() !== ""
        ? String(row.sale_price_brl).trim()
        : row.marketplace != null &&
            typeof row.marketplace === "object" &&
            (/** @type {Record<string, unknown>} */ (row.marketplace)).sale_price_brl != null
          ? String((/** @type {Record<string, unknown>} */ (row.marketplace)).sale_price_brl).trim()
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
  if (status === "expired") return { ok: false, reason: "expired" };
  if (status !== "active" && status !== "scheduled") return { ok: false, reason: "ended" };
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
      const pidRaw = row.ref_id ?? row.promotion_id ?? row.id;
      const pid = pidRaw != null && String(pidRaw).trim() !== "" ? String(pidRaw).trim() : null;
      if (!pid) continue;
      const sale = mercadoLivreToFiniteGrid(row.price ?? row.amount);
      const original = mercadoLivreToFiniteGrid(row.original_price ?? row.regular_amount);
      if (sale == null || original == null || original <= sale + TOL) continue;
      const startsAt = toIsoDateStringOrNull(
        row.start_time ?? row.start_date ?? row.date_from ?? row.starts_at
      );
      const endsAt = toIsoDateStringOrNull(
        row.finish_time ?? row.end_date ?? row.date_to ?? row.ends_at ?? row.stop_time
      );
      const rawStatus = row.status != null && String(row.status).trim() !== "" ? String(row.status).trim() : null;
      const status = classifyPromotionStatus({}, row, { inferActiveFromPriceEvidence: true });
      const nameRaw = row.name ?? row.promotion_name ?? row.type;
      const name =
        nameRaw != null && String(nameRaw).trim() !== "" ? String(nameRaw).trim() : `Promoção ${pid}`;
      upsertCandidate({
        promotion_id: pid,
        promotion_name: name,
        final_price_brl: new Decimal(sale).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        status,
        raw_status: rawStatus,
        starts_at: startsAt,
        ends_at: endsAt,
        source,
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
 * Tarifa em R$ alinhada ao preço da aba: % oficial × preço do cenário (evita herdar valor
 * calculado sobre catálogo/original quando a aba é promocional).
 * Sem % válido: mantém o valor vindo do net_proceeds.
 * @param {Decimal} priceDec
 * @param {string | null | undefined} feePctStr
 * @param {string | null | undefined} feeAmtFromNp
 * @returns {string | null}
 */
function resolveScenarioSaleFeeAmountBrl(priceDec, feePctStr, feeAmtFromNp) {
  const pct = toDec(feePctStr);
  if (pct != null && pct.gt(0) && priceDec.isFinite() && priceDec.gt(0)) {
    return priceDec.mul(pct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
  return feeAmtFromNp != null && String(feeAmtFromNp).trim() !== "" ? String(feeAmtFromNp).trim() : null;
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
 * }} p
 * @returns {Promise<Record<string, unknown>>}
 */
async function computeOneScenario(p) {
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

  const listingSim = listingWithSalePrice(listing, priceDec);
  const healthSim = cloneHealthForPricingScenario(health);
  const np = computeMercadoLivreUnitNetProceeds(listingSim, healthSim, metrics);
  const npOk = Boolean(np && /** @type {Record<string, unknown>} */ (np).has_valid_data === true);

  const lt = normalizeMercadoLivreListingType(
    listing.listing_type_id != null ? String(listing.listing_type_id) : null
  );

  const npRec = np && typeof np === "object" ? /** @type {Record<string, unknown>} */ (np) : {};
  const feePctStr =
    npRec.sale_fee_percent != null && String(npRec.sale_fee_percent).trim() !== ""
      ? String(npRec.sale_fee_percent).trim()
      : null;

  let feeAmtStrResolved =
    npRec.sale_fee_amount != null && String(npRec.sale_fee_amount).trim() !== ""
      ? String(npRec.sale_fee_amount).trim()
      : null;
  feeAmtStrResolved = resolveScenarioSaleFeeAmountBrl(priceDec, feePctStr, feeAmtStrResolved);
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

  const resolvedShipping = await resolveMercadoLivreScenarioShippingAsync({
    accessToken: p.mlAccessToken ?? null,
    itemId: p.itemMlId ?? null,
    zipCode: p.referenceZipCode ?? null,
    scenarioSaleDec: priceDec,
    npRec,
    healthOriginal: health,
    listing: listingSim,
    scenarioType: scenario_id,
    listingUuid: p.listingUuid ?? null,
  });
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

  if (!npOk) {
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
    shipping_source: shippingCostSource,
    is_shipping_estimated: resolvedShipping.is_shipping_estimated,
    promotion_source: pf?.promotion_source != null ? String(pf.promotion_source) : null,
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
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   listingId?: string;
 *   listingExternalId?: string;
 *   mlAccessToken?: string | null;
 *   referenceZipCode?: string | null;
 * }} keys
 */
export async function buildMercadoLivreListingPricingScenariosPayload(supabase, userId, keys) {
  const listingId = keys.listingId != null ? String(keys.listingId).trim() : "";
  const listingExternalId = keys.listingExternalId != null ? String(keys.listingExternalId).trim() : "";

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

  const baselinePriceStr = resolveBaselineSalePriceStr(listing, health, decStr);
  if (baselinePriceStr == null) {
    return {
      ok: false,
      error: "Não foi possível determinar o preço base (sem promoção) do anúncio.",
      status: 422,
    };
  }

  const persistedPromos = extractPromotionScenarios(listing, health, { source: "persisted" });
  let promos = persistedPromos;
  /** @type {ReturnType<typeof extractPromotionScenarios>} */
  let livePromos = [];
  const diag = {
    persisted_promos: persistedPromos.length,
    live_promos: 0,
    discarded_invalid: 0,
    discarded_ended: 0,
    discarded_expired: 0,
    used_live_enrichment: false,
  };

  const mlToken = keys.mlAccessToken ?? null;
  const refZip =
    keys.referenceZipCode != null && String(keys.referenceZipCode).trim() !== ""
      ? String(keys.referenceZipCode).trim()
      : "01310100";

  const itemMlId =
    external_listing_id != null && String(external_listing_id).trim() !== ""
      ? String(external_listing_id).trim()
      : listing.external_listing_id != null
        ? String(listing.external_listing_id).trim()
        : "";
  const listingUuid = listing.id != null ? String(listing.id) : null;
  const debugPromotionScenario = shouldEmitPromotionDebug(itemMlId);

  // Persistência local pode vir sem `prices[]` (ou parcial). Neste caso, buscamos o item ao vivo no ML
  // para recuperar múltiplas promoções válidas sem depender de montagem no frontend.
  if (mlToken && itemMlId && promos.length <= 1) {
    try {
      const liveItem = await fetchItem(mlToken, itemMlId);
      if (liveItem && typeof liveItem === "object") {
        const livePromotions = await fetchSellerPromotionsByItem(mlToken, itemMlId);
        const listingWithLivePromo = mergeListingWithLivePromotionPayload(
          /** @type {Record<string, unknown>} */ (listing),
          /** @type {Record<string, unknown>} */ (liveItem),
          livePromotions
        );
        const promosFromLive = extractPromotionScenarios(listingWithLivePromo, health, {
          source: "live",
        });
        livePromos = promosFromLive;
        diag.live_promos = promosFromLive.length;
        if (promosFromLive.length > promos.length) {
          diag.used_live_enrichment = true;
          promos = promosFromLive;
        }
      }
    } catch (e) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.PRICING_FALLBACK_APPLIED, {
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        external_listing_id: itemMlId,
        reason: "live_item_promotion_fetch_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const catalogBrl = resolveMercadoLivreBaselineCatalogBrl(listing, health);

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

  /** @type {Record<string, unknown>[]} */
  const promotionRowsRaw = [];
  /** @type {Record<string, unknown>[]} */
  const promotionDebugRows = [];
  if (debugPromotionScenario) {
    const selectedFingerprints = new Set(
      promos.map((p) => {
        const pid = p.promotion_id != null ? String(p.promotion_id).trim() : "";
        const sale = p.final_price_brl != null ? String(p.final_price_brl).trim() : "";
        const src = p.source != null ? String(p.source).trim() : "persisted";
        const s = p.starts_at != null ? String(p.starts_at).trim() : "";
        const e = p.ends_at != null ? String(p.ends_at).trim() : "";
        return `${src}|${pid}|${sale}|${s}|${e}`;
      })
    );
    const baseCandidates = [
      ...persistedPromos.map((p) => ({ p, fallbackReason: "superseded_by_live_enrichment" })),
      ...livePromos.map((p) => ({ p, fallbackReason: "not_selected_for_pipeline" })),
    ];
    for (const { p, fallbackReason } of baseCandidates) {
      const pid = p.promotion_id != null ? String(p.promotion_id).trim() : "";
      const sale = p.final_price_brl != null ? String(p.final_price_brl).trim() : "";
      const src = p.source != null ? String(p.source).trim() : "persisted";
      const s = p.starts_at != null ? String(p.starts_at).trim() : "";
      const e = p.ends_at != null ? String(p.ends_at).trim() : "";
      const fp = `${src}|${pid}|${sale}|${s}|${e}`;
      if (selectedFingerprints.has(fp)) continue;
      promotionDebugRows.push({
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        external_listing_id: itemMlId,
        source: src,
        promotion_id: pid || null,
        scenario_id: buildMlPromotionScenarioId(pid, p.starts_at, p.ends_at),
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
    const promoSource = pr.source != null ? String(pr.source) : "persisted";
    const rawStatus = pr.raw_status != null ? String(pr.raw_status) : null;
    const normalizedStatus = pr.status != null ? String(pr.status) : "unknown";
    const promoId = pr.promotion_id != null ? String(pr.promotion_id).trim() : "";
    const scenarioStableId = buildMlPromotionScenarioId(promoId, pr.starts_at, pr.ends_at);
    const promoSale = toDec(pr.final_price_brl);
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
    const eligibility = evaluatePromotionUiEligibility({ status: pr.status, ends_at: pr.ends_at });
    if (!eligibility.ok) {
      if (eligibility.reason === "expired") diag.discarded_expired += 1;
      else diag.discarded_ended += 1;
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
    if (!promoId || promoSale == null || !promoSale.isFinite() || promoSale.lte(0)) {
      diag.discarded_invalid += 1;
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.ML_PROMOTION_SCENARIO_SKIPPED_INVALID, {
        marketplace: "mercado_livre",
        listing_id: listingUuid,
        promotion_id: promoId || null,
        reason: !promoId ? "missing_promotion_id" : "invalid_sale_price_brl",
      });
      if (debugPromotionScenario)
        promotionDebugRows.push({
          ...debugBase,
          discard_reason: !promoId ? "missing_promotion_id" : "invalid_sale_price_brl",
          included_in_final: false,
        });
      continue;
    }
    try {
      const promoFin = resolveMercadoLivrePromotionFinancials({
        listing,
        promotionId: promoId,
        promoPriceBrl: pr.final_price_brl,
        baselineCatalogBrl: catalogBrl,
      });
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
        promotion_active: pr.status === "active",
        is_baseline: false,
        mlAccessToken: mlToken,
        referenceZipCode: refZip,
        itemMlId,
        listingUuid,
        promotionFinancials: promoFin,
      });
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
    },
  };
}
