// ======================================================
// Promoções ML — normalização oficial (GET /seller-promotions/items/:id?app_version=v2)
// Regra de negócio: id + type + ref_id | status started/pending/candidate
// ======================================================

import Decimal from "decimal.js";
import { mercadoLivreToFiniteGrid } from "../../handlers/ml/_helpers/mercadoLivreListingMoneyShared.js";
import {
  candidateLiquidaFullOutletPrefereMaxQuandoSuggestedCrossPromoSemPrice,
  candidateLiquidaFullOutletPrefereMaxTierModestoExibido,
  candidateLiquidaFullOutletRejeitaPriceCrossPromo,
  logS7PromotionPriceResolverAudit,
  resolvePromotionPriceViaRegistry,
} from "./mercadoLivrePromotionPriceResolverRegistry.js";
import {
  buildListingVariationContextForPromotions,
  buildPromotionVariationLinkageV1,
  buildPromotionVariationRangeAuditPayload,
  listingHasMultipleVariations,
  logS7PromotionVariationContextPropagation,
  logS7PromotionVariationRangeAudit,
} from "./mercadoLivrePromotionVariationRangeAudit.js";

export { buildListingVariationContextForPromotions, logS7PromotionVariationContextPropagation };
import {
  logS7PromotionResolverPanelParity,
  resolveMercadoLivrePromotionPanelParity,
} from "./strategies/mercadoLivrePromotionPanelParityResolver.js";
import {
  buildPromotionLivePayloadMeta,
  emitPromotionFinalParityDecisionLogs,
  isS7PromotionDebugEnabled,
  logS7PromotionDebugParity,
} from "./mercadoLivrePromotionLivePayloadAudit.js";
import { enrichPromotionContractWithFunding } from "../promotions/marketplaces/mercadoLivrePromotionFundingResolver.js";

/** @param {unknown} field @param {unknown} value */
export function logS7MlPromosAudit(field, value) {
  if (process.env.NODE_ENV === "production" && process.env.S7_ML_PROMOS_AUDIT !== "1") return;
  console.info(`[S7_ML_PROMOS_AUDIT] ${field}`, value);
}

/** @param {string} stage @param {Record<string, unknown>} payload */
export function logS7PromotionsPiAudit(stage, payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info(`[S7_PROMOTIONS_PI_AUDIT] ${stage}`, payload);
}

/**
 * Chave composta oficial: id + type + ref_id (fallback seguro quando faltar campo).
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function buildOfficialSellerPromotionIdentityKey(row) {
  const id =
    row.id != null && String(row.id).trim() !== ""
      ? String(row.id).trim()
      : row.promotion_id != null && String(row.promotion_id).trim() !== ""
        ? String(row.promotion_id).trim()
        : "";
  const type =
    row.type != null && String(row.type).trim() !== ""
      ? String(row.type).trim()
      : row.promotion_type != null && String(row.promotion_type).trim() !== ""
        ? String(row.promotion_type).trim()
        : "";
  const refId =
    row.ref_id != null && String(row.ref_id).trim() !== ""
      ? String(row.ref_id).trim()
      : row.offer_id != null && String(row.offer_id).trim() !== ""
        ? String(row.offer_id).trim()
        : "";
  if (id !== "" || type !== "" || refId !== "") {
    const subType =
      row.sub_type != null && String(row.sub_type).trim() !== "" ? String(row.sub_type).trim() : "";
    const name =
      row.name != null && String(row.name).trim() !== ""
        ? String(row.name).trim()
        : row.promotion_name != null && String(row.promotion_name).trim() !== ""
          ? String(row.promotion_name).trim()
          : "";
    return [id, type, refId, subType, name].map((v) => String(v).trim()).join("|");
  }
  const status = row.status != null ? String(row.status).trim() : "";
  const start = row.start_date ?? row.start_time ?? row.starts_at ?? "";
  const finish = row.finish_date ?? row.end_date ?? row.finish_time ?? row.ends_at ?? "";
  const priceRef = row.suggested_discounted_price ?? row.price ?? "";
  return [id || row.promotion_id || "", type, refId || row.offer_id || "", status, start, finish, priceRef]
    .map((v) => (v != null ? String(v).trim() : ""))
    .join("|");
}

/**
 * Chave forte para dedupe de lista — promotion_id | offer_id | promotion_type | name.
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function buildOfficialSellerPromotionListDedupeKey(row) {
  const id =
    row.id != null && String(row.id).trim() !== ""
      ? String(row.id).trim()
      : row.promotion_id != null && String(row.promotion_id).trim() !== ""
        ? String(row.promotion_id).trim()
        : "";
  const offerId =
    row.ref_id != null && String(row.ref_id).trim() !== ""
      ? String(row.ref_id).trim()
      : row.offer_id != null && String(row.offer_id).trim() !== ""
        ? String(row.offer_id).trim()
        : "";
  const type =
    row.type != null && String(row.type).trim() !== ""
      ? String(row.type).trim()
      : row.promotion_type != null && String(row.promotion_type).trim() !== ""
        ? String(row.promotion_type).trim()
        : "";
  const name =
    row.name != null && String(row.name).trim() !== ""
      ? String(row.name).trim()
      : row.promotion_name != null && String(row.promotion_name).trim() !== ""
        ? String(row.promotion_name).trim()
        : "";
  const subType =
    row.sub_type != null && String(row.sub_type).trim() !== "" ? String(row.sub_type).trim() : "";
  return [id, offerId, type, subType, name].map((v) => String(v).trim()).join("|");
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function pickOfficialPromotionIdFromRawRow(row) {
  const candidates = [row.id, row.promotion_id, row.campaign_id, row.deal_id];
  for (const raw of candidates) {
    if (raw != null && String(raw).trim() !== "") return String(raw).trim();
  }
  const dedupe = buildOfficialSellerPromotionListDedupeKey(row);
  if (dedupe.replace(/\|/g, "") !== "") return `dedupe:${dedupe}`;
  const name = row.name ?? row.promotion_name;
  if (name != null && String(name).trim() !== "") {
    return `name:${String(name).trim().toLowerCase().replace(/\s+/g, "_")}`;
  }
  return "";
}

/**
 * Linha técnica PRICE_DISCOUNT sem id/nome — tier genérico ML, não é campanha participável na UI oficial.
 * @param {Record<string, unknown>} row
 */
export function isStructuralAnonymousPriceDiscountRow(row) {
  const typeRaw = row.type ?? row.promotion_type ?? row.sub_type ?? "";
  const typeNorm = typeRaw != null ? String(typeRaw).trim().toUpperCase() : "";
  if (typeNorm !== "PRICE_DISCOUNT") return false;
  const nameRaw = row.name ?? row.promotion_name ?? "";
  const hasName = nameRaw != null && String(nameRaw).trim() !== "";
  if (hasName) return false;
  const idRaw = row.id ?? row.promotion_id ?? row.campaign_id ?? row.deal_id ?? "";
  return idRaw == null || String(idRaw).trim() === "";
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionPriceContaminationAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_PRICE_CONTAMINATION_AUDIT]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionLiquidaCaseAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_LIQUIDA_CASE_AUDIT]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionMissingPromotionAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_MISSING_PROMOTION_AUDIT]", payload);
}

/** @param {Record<string, unknown>} row @returns {boolean} */
export function isLiquidaFullOutletOfficialSellerPromotionRow(row) {
  const nameRaw = row.name ?? row.promotion_name ?? "";
  const name = String(nameRaw).trim().toLowerCase();
  return name.includes("liquida full") && name.includes("outlet");
}

/** @param {Record<string, unknown>} row @returns {boolean} */
export function isNamedOfficialSellerPromotionRow(row) {
  const id = pickOfficialPromotionIdFromRawRow(row);
  if (id === "" || id.startsWith("dedupe:") || id.startsWith("name:")) return false;
  const nameRaw = row.name ?? row.promotion_name ?? "";
  return nameRaw != null && String(nameRaw).trim() !== "";
}

/** @param {unknown} typeValue @returns {boolean} */
export function tipoIndicaCampanhaDealPromocao(typeValue) {
  const t = typeValue != null ? String(typeValue).trim().toUpperCase() : "";
  return (
    t === "DEAL" ||
    t === "MARKETPLACE_CAMPAIGN" ||
    t === "DOD" ||
    t === "PRE_NEGOTIATED" ||
    t === "VOLUME"
  );
}

/**
 * Valores de preço de linhas PRICE_DISCOUNT anônimas — nunca reutilizar em promoção nomeada.
 * @param {Record<string, unknown>[]} rawRows
 */
export function buildStructuralAnonymousPriceDenylist(rawRows) {
  /** @type {Set<string>} */
  const out = new Set();
  const list = Array.isArray(rawRows) ? rawRows : [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    if (!isStructuralAnonymousPriceDiscountRow(row)) continue;
    for (const field of ["price", "suggested_discounted_price", "max_discounted_price", "min_discounted_price"]) {
      const dec = pickValidFinalBelowOriginal(toDec(row[field]), pickOriginalPriceDec(row));
      if (dec != null) out.add(dec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
    }
  }
  return out;
}

/** @param {Decimal | null} candidate @param {Set<string>} denylist @returns {boolean} */
function priceMatchesStructuralAnonymousDenylist(candidate, denylist) {
  if (candidate == null || !candidate.isFinite() || denylist.size === 0) return false;
  const key = candidate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  if (denylist.has(key)) return true;
  for (const denied of denylist) {
    try {
      const deniedDec = new Decimal(denied);
      if (candidate.minus(deniedDec).abs().lte(new Decimal("0.02"))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Campanha DEAL nomeada com price=0: max pode ser o tier exibido (ex.: 07.07 15%), suggested tier agressivo/outlet.
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 * @param {Decimal | null} maxDec
 * @param {Decimal | null} suggestedDec
 */
function candidateNamedDealPrefereMaxTierExibido(row, originalDec, maxDec, suggestedDec) {
  if (!isNamedOfficialSellerPromotionRow(row)) return false;
  const promoType = row.type ?? row.promotion_type ?? row.sub_type;
  if (!tipoIndicaCampanhaDealPromocao(promoType)) return false;
  if (originalDec == null || maxDec == null || suggestedDec == null || !suggestedDec.lt(maxDec)) return false;
  const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
  const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);
  return maxDiscPct.gte(10) && maxDiscPct.lte(22) && suggestedDiscPct.minus(maxDiscPct).gte(8);
}

/** Tier modesto exibido no ML (ex.: Fogão 5%) — regras Liquida vivem no PromotionPriceResolverRegistry. */
const LIQUIDA_MAX_TIER_MODOSTO_DISC_PCT = new Decimal("6");

/**
 * @param {Record<string, unknown>} row
 * @param {{ finalPriceDec: Decimal | null; finalPriceSource: string | null }} pickResult
 * @param {{
 *   listingId?: string | null;
 *   variationId?: string | null;
 *   sameListingOtherPromotionPrices?: string[];
 * }} [opts]
 */
export function buildLiquidaFullOutletCaseAuditPayload(row, pickResult, opts = {}) {
  const originalDec = pickOriginalPriceDec(row);
  const priceDec = pickValidFinalBelowOriginal(
    toDec(row.price ?? row.amount ?? row.deal_price),
    originalDec
  );
  const maxDec = pickValidFinalBelowOriginal(toDec(row.max_discounted_price), originalDec);
  const suggestedDec = pickValidFinalBelowOriginal(toDec(row.suggested_discounted_price), originalDec);
  const minDec = pickValidFinalBelowOriginal(toDec(row.min_discounted_price), originalDec);
  const picked = pickResult.finalPriceDec;

  /** @type {{ price_brl: string; source: string }[]} */
  const rejectedCandidatePrices = [];
  /** @type {{ price: Decimal; source: string }[]} */
  const candidates = [];
  if (priceDec != null) candidates.push({ price: priceDec, source: "price" });
  if (suggestedDec != null) candidates.push({ price: suggestedDec, source: "suggested_discounted_price" });
  if (maxDec != null) candidates.push({ price: maxDec, source: "max_discounted_price" });
  if (minDec != null) candidates.push({ price: minDec, source: "min_discounted_price" });
  for (const candidate of candidates) {
    if (picked != null && candidate.price.eq(picked)) continue;
    rejectedCandidatePrices.push({
      price_brl: decStr2(candidate.price),
      source: candidate.source,
    });
  }

  const sameListingOtherPromotionPrices = Array.isArray(opts.sameListingOtherPromotionPrices)
    ? opts.sameListingOtherPromotionPrices
    : [];
  const aggressivePriceDec = priceDec ?? suggestedDec;
  let contaminatedByOtherPromotion = false;
  if (aggressivePriceDec != null && sameListingOtherPromotionPrices.length > 0) {
    for (const otherPrice of sameListingOtherPromotionPrices) {
      try {
        const otherDec = new Decimal(String(otherPrice));
        if (aggressivePriceDec.minus(otherDec).abs().lte(new Decimal("0.02"))) {
          contaminatedByOtherPromotion = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (
    !contaminatedByOtherPromotion &&
    candidateLiquidaFullOutletPrefereMaxTierModestoExibido(
      row,
      originalDec,
      priceDec,
      maxDec,
      suggestedDec
    )
  ) {
    contaminatedByOtherPromotion = true;
  }

  return {
    listing_id: opts.listingId ?? row.item_id ?? row.listing_id ?? null,
    variation_id: opts.variationId ?? row.variation_id ?? null,
    promotion_name: row.name ?? row.promotion_name ?? null,
    promotion_id: row.id ?? row.promotion_id ?? null,
    offer_id: row.ref_id ?? row.offer_id ?? null,
    promotion_type: row.type ?? row.promotion_type ?? null,
    sub_type: row.sub_type ?? null,
    original_price_brl: originalDec != null ? decStr2(originalDec) : null,
    raw_price: row.price ?? row.amount ?? row.deal_price ?? null,
    raw_suggested_discounted_price: row.suggested_discounted_price ?? null,
    raw_max_discounted_price: row.max_discounted_price ?? null,
    raw_min_discounted_price: row.min_discounted_price ?? null,
    picked_final_price_brl: picked != null ? decStr2(picked) : null,
    picked_final_price_source: pickResult.finalPriceSource,
    rejected_candidate_prices: rejectedCandidatePrices,
    source_identity_key: buildOfficialSellerPromotionListDedupeKey(row),
    matched_by: pickResult.finalPriceSource ?? "pickOfficialPromotionFinalPrice",
    same_listing_other_promotion_prices: sameListingOtherPromotionPrices,
    contaminated_by_other_promotion: contaminatedByOtherPromotion,
  };
}

/**
 * @param {Record<string, unknown>} currentRow
 * @param {Record<string, unknown>[]} siblingRows
 * @param {Set<string>} [structuralDenylist]
 * @returns {string[]}
 */
function collectSameListingOtherPromotionPrices(currentRow, siblingRows, structuralDenylist = new Set()) {
  if (!Array.isArray(siblingRows)) return [];
  const currentId = pickOfficialPromotionIdFromRawRow(currentRow);
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const sibling of siblingRows) {
    if (!sibling || typeof sibling !== "object") continue;
    const siblingId = pickOfficialPromotionIdFromRawRow(sibling);
    if (siblingId !== "" && siblingId === currentId) continue;
    if (isLiquidaFullOutletOfficialSellerPromotionRow(sibling)) continue;
    const siblingUi = resolvePromotionUiFinancials(sibling, {
      structuralAnonymousPriceDenylist: structuralDenylist,
      skipLiquidaCaseAudit: true,
    });
    if (siblingUi.final_price_brl != null && !seen.has(siblingUi.final_price_brl)) {
      seen.add(siblingUi.final_price_brl);
      out.push(siblingUi.final_price_brl);
    }
  }
  return out;
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionListCompletenessAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_LIST_COMPLETENESS_AUDIT]", payload);
}

/**
 * @param {Record<string, unknown>[]} rawRows
 * @param {Record<string, unknown>[]} renderedRows
 */
export function buildPromotionPriceContaminationAuditPayload(rawRows, renderedRows, ctx = {}) {
  const list = Array.isArray(rawRows) ? rawRows : [];
  const rendered = Array.isArray(renderedRows) ? renderedRows : [];
  /** @type {Record<string, unknown>[]} */
  const structuralAnonymousRows = [];
  /** @type {Set<string>} */
  const renderedIdentityKeys = new Set();

  for (const row of rendered) {
    if (!row || typeof row !== "object") continue;
    const card =
      row.promotion_card_contract != null && typeof row.promotion_card_contract === "object"
        ? /** @type {Record<string, unknown>} */ (row.promotion_card_contract)
        : null;
    const key =
      card?.source_identity_key != null
        ? String(card.source_identity_key)
        : buildOfficialSellerPromotionListDedupeKey(
            /** @type {Record<string, unknown>} */ ({
              id: row.promotion_id,
              ref_id: row.offer_id,
              type: row.promotion_type,
              name: row.promotion_name,
            })
          );
    if (key.replace(/\|/g, "") !== "") renderedIdentityKeys.add(key);
  }

  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    if (!isStructuralAnonymousPriceDiscountRow(row)) continue;
    structuralAnonymousRows.push({
      promotion_type: row.type ?? row.promotion_type ?? null,
      sub_type: row.sub_type ?? null,
      price: row.price ?? null,
      original_price: row.original_price ?? null,
      suggested_discounted_price: row.suggested_discounted_price ?? null,
      max_discounted_price: row.max_discounted_price ?? null,
      reason: "structural_anonymous_price_discount",
      used_in_any_named_promotion: false,
    });
  }

  /** @type {Record<string, unknown>[]} */
  const renderedPromotions = [];
  for (const row of rendered) {
    if (!row || typeof row !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    const card =
      r.promotion_card_contract != null && typeof r.promotion_card_contract === "object"
        ? /** @type {Record<string, unknown>} */ (r.promotion_card_contract)
        : /** @type {Record<string, unknown>} */ ({});
    renderedPromotions.push({
      promotion_name: card.promotion_name ?? r.promotion_name ?? null,
      promotion_id: card.promotion_id ?? r.promotion_id ?? null,
      offer_id: card.offer_id ?? r.offer_id ?? null,
      promotion_type: card.promotion_type ?? r.promotion_type ?? null,
      sub_type: card.sub_type ?? null,
      source_identity_key: card.source_identity_key ?? null,
      original_price_brl: card.original_price_brl ?? null,
      real_promotion_final_price_brl: card.real_promotion_final_price_brl ?? null,
      discount_amount_brl: card.discount_amount_brl ?? null,
      discount_percent_display: card.discount_percent_display ?? null,
      final_price_source: card.final_price_source ?? null,
      contaminated_by_anonymous_price_discount: card.contaminated_by_anonymous_price_discount === true,
      expected_for_case: ctx.expected_for_case?.[String(card.promotion_name ?? r.promotion_name ?? "")] ?? null,
    });
  }

  return {
    listing_id: ctx.listing_id ?? null,
    marketplace_account_id: ctx.marketplace_account_id ?? null,
    raw_total_promotions: list.length,
    normalized_total_promotions: ctx.normalized_total_promotions ?? null,
    rendered_total_promotions: rendered.length,
    structural_anonymous_rows: structuralAnonymousRows,
    rendered_promotions: renderedPromotions,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {{ included?: boolean; excluded_reason?: string | null; final_price_picked?: string | null }} ctx
 */
export function buildPromotionListCompletenessRawAuditEntry(row, ctx = {}) {
  const ui = resolvePromotionUiFinancials(row);
  return {
    promotion_id: pickOfficialPromotionIdFromRawRow(row) || null,
    offer_id: row.ref_id ?? row.offer_id ?? null,
    promotion_name: row.name ?? row.promotion_name ?? null,
    promotion_type: row.type ?? row.promotion_type ?? null,
    status: row.status ?? null,
    original_price: row.original_price ?? row.regular_amount ?? ui.original_price_brl ?? null,
    price: row.price ?? row.amount ?? row.deal_price ?? ui.price_raw ?? null,
    suggested_discounted_price: row.suggested_discounted_price ?? null,
    max_discounted_price: row.max_discounted_price ?? null,
    final_price_picked: ctx.final_price_picked ?? ui.final_price_brl ?? null,
    included: ctx.included === true,
    excluded_reason: ctx.excluded_reason ?? null,
  };
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

/**
 * Classificação oficial ML → contrato Suse7 (sem inferir ATIVA).
 * @param {unknown} rawStatus
 * @returns {{
 *   normalized_status: string;
 *   ml_effective_state: "active" | "scheduled" | "participate";
 *   promotion_active: boolean;
 *   raw_status: string;
 * }}
 */
export function classifyOfficialMlSellerPromotionStatus(rawStatus) {
  const raw = rawStatus != null ? String(rawStatus).trim().toLowerCase() : "";
  if (raw === "started") {
    return {
      normalized_status: "active",
      ml_effective_state: "active",
      promotion_active: true,
      raw_status: "started",
    };
  }
  if (raw === "pending") {
    return {
      normalized_status: "scheduled",
      ml_effective_state: "scheduled",
      promotion_active: false,
      raw_status: "pending",
    };
  }
  if (raw === "candidate") {
    return {
      normalized_status: "candidate",
      ml_effective_state: "participate",
      promotion_active: false,
      raw_status: "candidate",
    };
  }
  if (raw !== "") {
    logS7MlPromosAudit("status_unknown_mapped_to_available", raw);
  }
  return {
    normalized_status: "candidate",
    ml_effective_state: "participate",
    promotion_active: false,
    raw_status: raw !== "" ? raw : "unknown",
  };
}

/** @param {Record<string, unknown>} row @returns {boolean} */
export function isBoostedOfferTruthy(row) {
  const v = row?.boosted_offer;
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}

/** @param {Record<string, unknown>} row */
function rawPromotionStatusNormalized(row) {
  const s = row.status ?? row.raw_status ?? "";
  return String(s).trim().toLowerCase();
}

/** @param {string} statusNorm */
function isCandidateLikePromotionStatus(statusNorm) {
  return statusNorm === "" || statusNorm === "candidate" || statusNorm === "unknown";
}

/** @param {Decimal | null} dec @param {Decimal | null} originalDec */
function pickValidFinalBelowOriginal(dec, originalDec) {
  if (dec == null || !dec.gt(0)) return null;
  if (originalDec != null && originalDec.gt(0) && dec.gte(originalDec)) return null;
  return dec;
}

/** @param {string} statusNorm */
function isStartedLikePromotionStatus(statusNorm) {
  return statusNorm === "started" || statusNorm === "active" || statusNorm === "pending";
}

/** @param {Decimal | null} originalDec @param {Decimal | null} priceDec @param {Decimal | null} maxDec */
function candidateTierGapAmbiguous(originalDec, priceDec, maxDec) {
  if (originalDec == null || !originalDec.gt(0)) return false;
  if (priceDec == null || maxDec == null || !maxDec.gt(priceDec)) return false;
  return maxDec.minus(priceDec).div(originalDec).lte(new Decimal("0.05"));
}

/**
 * SSOT — delega ao PromotionPriceResolverRegistry (estratégia por família).
 *
 * @param {Record<string, unknown>} row
 * @param {{
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 *   listingId?: string | null;
 *   variationId?: string | null;
 * }} [opts]
 * @returns {{ finalPriceDec: Decimal | null; finalPriceSource: string | null }}
 */
export function pickOfficialPromotionFinalPrice(row, opts = {}) {
  const resolved = resolvePromotionPriceViaRegistry(row, opts);
  return {
    finalPriceDec: resolved.finalPriceDec,
    finalPriceSource: resolved.finalPriceSource,
  };
}

/**
 * SSOT UI/financeira — preço final e desconto exibidos na tabela ML por item/promoção.
 * GET /seller-promotions/items/{ITEM_ID}?app_version=v2
 *
 * Regras:
 * - final_price = boosted_offer ? total_price_for_boosted_offer : price
 * - discount = original_price - final_price
 * - seller_percentage / meli_percentage são apenas audit (NÃO desconto final)
 *
 * @param {Record<string, unknown>} rawRow
 * @param {{
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 *   listingId?: string | null;
 *   variationId?: string | null;
 *   parentListingId?: string | null;
 *   listingContext?: {
 *     variations_count?: number | null;
 *     raw_json?: Record<string, unknown> | null;
 *   };
 *   enrichmentItemRows?: Record<string, unknown>[] | null;
 *   skipLiquidaCaseAudit?: boolean;
 * }} [opts]
 */
export function resolvePromotionUiFinancials(rawRow, opts = {}) {
  const row = rawRow != null && typeof rawRow === "object" ? rawRow : /** @type {Record<string, unknown>} */ ({});
  const originalDec = pickOriginalPriceDec(row);
  const boostedOffer = isBoostedOfferTruthy(row);
  const resolved = resolvePromotionPriceViaRegistry(row, opts);

  const panel = resolveMercadoLivrePromotionPanelParity(row, {
    registryFinalPriceDec: resolved.finalPriceDec,
    registryFinalPriceSource: resolved.finalPriceSource,
    sameListingOtherPromotionPrices: opts.sameListingOtherPromotionPrices,
    sameListingSiblingRows: opts.sameListingSiblingRows,
    listingId: opts.listingId ?? null,
    listingHasVariations:
      opts.listingContext?.has_listing_variations === true ||
      listingHasMultipleVariations(opts.listingContext ?? {}),
  });

  const finalPriceDec = panel.finalPriceDec;
  const finalPriceSource = panel.finalPriceSource;
  const discountAmountDec = panel.discountAmountDec;
  const discountPercentDec = panel.discountPercentDec;

  const sellerPctRaw = pickFirstRaw(row, [
    "seller_percentage",
    "seller_discount_percentage",
    "seller_discount_percent",
  ]);
  const meliPctRaw = pickFirstRaw(row, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"]);

  const sourceConfidence =
    originalDec != null && originalDec.gt(0) && finalPriceDec != null && finalPriceDec.gt(0)
      ? "official_item_promotion_price"
      : "missing_price_fields";

  /** @type {string[]} */
  const sourceWarnings = [];
  if (sourceConfidence !== "official_item_promotion_price") {
    sourceWarnings.push("missing_original_or_final_price");
  }
  for (const code of panel.warningCodes) {
    if (!sourceWarnings.includes(code)) sourceWarnings.push(code);
  }

  const variationRangeAudit = buildPromotionVariationRangeAuditPayload({
    row,
    selectedFinalPriceBrl: finalPriceDec != null ? decStr2(finalPriceDec) : null,
    selectedFinalPriceSource: finalPriceSource,
    listingId: opts.listingId ?? null,
    parentListingId: opts.parentListingId ?? null,
    variationId: opts.variationId ?? null,
    listingContext: opts.listingContext ?? null,
    enrichmentItemRows: opts.enrichmentItemRows ?? null,
  });
  if (variationRangeAudit.silent_single_price_selected === true) {
    sourceWarnings.push("variation_range_ambiguous_single_price_selected");
  }
  if (variationRangeAudit.has_price_range === true) {
    sourceWarnings.push("promotion_price_range_detected");
  }
  if (variationRangeAudit.has_listing_variations === true) {
    sourceWarnings.push("listing_has_multiple_variations");
  }

  const ui = {
    original_price_brl: originalDec != null ? decStr2(originalDec) : null,
    final_price_brl: finalPriceDec != null ? decStr2(finalPriceDec) : null,
    discount_amount_brl: discountAmountDec != null ? decStr2(discountAmountDec) : null,
    discount_percent_decimal: discountPercentDec != null ? decStr2(discountPercentDec) : null,
    discount_percent_display: panel.discountPercentDisplay,
    discount_source: panel.discountPercentSource,
    final_price_source: finalPriceSource,
    boosted_offer: boostedOffer,
    seller_percentage_raw: sellerPctRaw ?? null,
    meli_percentage_raw: meliPctRaw ?? null,
    discount_meli_boosted_percentage_raw:
      pickFirstRaw(row, ["discount_meli_boosted_percentage", "meli_boosted_percentage"]) ?? null,
    discount_meli_boost_amount_raw:
      pickFirstRaw(row, ["discount_meli_boost_amount", "meli_boost_amount"]) ?? null,
    total_price_for_boosted_offer_raw: row.total_price_for_boosted_offer ?? null,
    price_raw: row.price ?? row.amount ?? row.deal_price ?? null,
    source_confidence: sourceConfidence,
    source_warnings: sourceWarnings,
    variation_range_audit: variationRangeAudit,
    variation_linkage_v1: buildPromotionVariationLinkageV1(variationRangeAudit),
    panel_parity: {
      selected_final_price: finalPriceDec != null ? decStr2(finalPriceDec) : null,
      raw_final_price_from_ml: panel.rawFinalPriceDec != null ? decStr2(panel.rawFinalPriceDec) : null,
      selected_discount_amount: discountAmountDec != null ? decStr2(discountAmountDec) : null,
      raw_discount_amount_from_ml:
        panel.rawDiscountAmountDec != null ? decStr2(panel.rawDiscountAmountDec) : null,
      selected_discount_percent: panel.discountPercentDisplay,
      selected_source_path: panel.selectedSourcePath,
      selected_rule: panel.selectedRule,
      selected_variation_id: row.variation_id != null ? String(row.variation_id) : null,
      has_variation_range: panel.hasVariationRange,
      is_ambiguous: panel.isAmbiguous,
      warning_codes: panel.warningCodes,
      source_trace: panel.sourceTrace,
      promotion_price_candidates: panel.promotionPriceCandidates,
      payout_brl: panel.payoutBrl,
    },
  };

  logS7PromotionResolverPanelParity(panel.auditPayload);

  logS7PromotionsPiAudit("promotion_ui_financials", {
    promotion_id: row.id ?? row.promotion_id ?? null,
    promotion_name: row.name ?? row.promotion_name ?? null,
    original_price: ui.original_price_brl,
    price_raw: ui.price_raw,
    boosted_offer: ui.boosted_offer,
    boosted_offer_typeof: typeof row.boosted_offer,
    total_price_for_boosted_offer_raw: ui.total_price_for_boosted_offer_raw,
    max_discounted_price_raw: row.max_discounted_price ?? null,
    suggested_discounted_price_raw: row.suggested_discounted_price ?? null,
    final_price_used: ui.final_price_brl,
    final_price_source: ui.final_price_source,
    discount_amount_calculated: ui.discount_amount_brl,
    discount_percent_calculated: ui.discount_percent_decimal,
    discount_percent_display: ui.discount_percent_display,
    seller_percentage_raw: ui.seller_percentage_raw,
    meli_percentage_raw: ui.meli_percentage_raw,
    source_confidence: ui.source_confidence,
    panel_selected_rule: panel.selectedRule,
    panel_selected_source_path: panel.selectedSourcePath,
  });

  if (!opts.skipLiquidaCaseAudit && isLiquidaFullOutletOfficialSellerPromotionRow(row)) {
    logS7PromotionLiquidaCaseAudit(
      buildLiquidaFullOutletCaseAuditPayload(
        row,
        { finalPriceDec, finalPriceSource },
        {
          listingId: opts.listingId ?? null,
          variationId: opts.variationId ?? null,
          sameListingOtherPromotionPrices: opts.sameListingOtherPromotionPrices,
        }
      )
    );
  }

  logS7PromotionPriceResolverAudit({
    ...resolved.audit,
    listing_id:
      opts.listingId ??
      resolved.audit.listing_id ??
      row.item_id ??
      row.listing_id ??
      null,
    variation_id: opts.variationId ?? row.variation_id ?? null,
  });

  logS7PromotionVariationRangeAudit(variationRangeAudit);

  return ui;
}

/**
 * Preço aplicado + referência oficial (boosted ? total_price_for_boosted_offer : price).
 * price=0 sem preço efetivo → suggested/min/max só para listagem (price_applied=false).
 * @param {Record<string, unknown>} row
 * @param {{
 *   sameListingOtherPromotionPrices?: string[];
 *   skipLiquidaCaseAudit?: boolean;
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   sameListingSiblingRows?: Record<string, unknown>[];
 *   listingId?: string | null;
 *   listingContext?: {
 *     variations_count?: number | null;
 *     has_listing_variations?: boolean | null;
 *     raw_json?: Record<string, unknown> | null;
 *   };
 * }} [opts]
 */
export function resolveOfficialSellerPromotionPrices(row, opts = {}) {
  const ui = resolvePromotionUiFinancials(row, opts);

  if (ui.final_price_brl != null && ui.source_confidence === "official_item_promotion_price") {
    return {
      final_price_brl: ui.final_price_brl,
      reference_price_brl: ui.original_price_brl,
      price_applied: true,
    };
  }

  const original =
    mercadoLivreToFiniteGrid(row.original_price ?? row.regular_amount ?? row.base_price) ?? null;

  for (const field of ["suggested_discounted_price", "min_discounted_price", "max_discounted_price", "top_deal_price"]) {
    const v = mercadoLivreToFiniteGrid(row[field]);
    if (v != null && v > 0) {
      return {
        final_price_brl: new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        reference_price_brl:
          original != null ? new Decimal(original).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : ui.original_price_brl,
        price_applied: false,
      };
    }
  }

  return {
    final_price_brl: null,
    reference_price_brl: ui.original_price_brl ??
      (original != null ? new Decimal(original).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null),
    price_applied: false,
  };
}

const ROUND = Decimal.ROUND_HALF_UP;

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
function decStr2(d) {
  if (d == null) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/** @param {Record<string, unknown>} row @returns {unknown} */
function pickFirstRaw(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  const meta =
    row.metadata != null && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : null;
  if (meta) {
    for (const k of keys) {
      if (meta[k] != null && String(meta[k]).trim() !== "") return meta[k];
    }
  }
  return null;
}

const ORIGINAL_PRICE_FIELD_KEYS = [
  "original_price",
  "regular_amount",
  "base_price",
  "list_price",
  "regular_price",
  "full_price",
];

/** @param {Record<string, unknown>} row @returns {string | null} */
export function pickOriginalPriceFieldName(row) {
  for (const key of ORIGINAL_PRICE_FIELD_KEYS) {
    const raw = pickFirstRaw(row, [key]);
    if (raw != null && String(raw).trim() !== "") return key;
  }
  return null;
}

/** @param {Record<string, unknown>} row @returns {Decimal | null} */
function pickOriginalPriceDec(row) {
  return toDec(pickFirstRaw(row, ORIGINAL_PRICE_FIELD_KEYS));
}

/**
 * Payload auditável SSOT — promoção normalizada entregue ao frontend.
 *
 * @param {Record<string, unknown>} row — scenario row (promotion_scenarios[])
 * @param {{
 *   listing_external_id?: string | null;
 *   marketplace_account_id?: string | null;
 *   listing_type?: string | null;
 *   marketplace?: string | null;
 * }} [ctx]
 */
export function buildPromotionScenarioSsotAuditPayload(row, ctx = {}) {
  const contract =
    row.promotion_offer_contract != null && typeof row.promotion_offer_contract === "object"
      ? /** @type {Record<string, unknown>} */ (row.promotion_offer_contract)
      : /** @type {Record<string, unknown>} */ ({});
  const m =
    row.marketplace != null && typeof row.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (row.marketplace)
      : /** @type {Record<string, unknown>} */ ({});
  const res =
    row.result != null && typeof row.result === "object"
      ? /** @type {Record<string, unknown>} */ (row.result)
      : /** @type {Record<string, unknown>} */ ({});

  return {
    listing_id:
      ctx.listing_external_id ??
      contract.listing_id ??
      row.external_listing_id ??
      null,
    marketplace_account_id: ctx.marketplace_account_id ?? null,
    marketplace: ctx.marketplace ?? "mercado_livre",
    promotion_id: contract.promotion_id ?? row.promotion_id ?? null,
    promotion_type: contract.promotion_type ?? row.promotion_type ?? null,
    status: contract.ml_raw_status ?? row.ml_promotion_raw_status ?? row.status ?? null,
    promotion_name: contract.promotion_name ?? row.promotion_name ?? row.label ?? null,
    base_price: contract.original_price_brl ?? m.original_price_brl ?? null,
    promotion_price: contract.final_price_brl ?? m.sale_price_brl ?? null,
    discount_percent: contract.discount_percent_display ?? null,
    discount_percent_decimal: contract.discount_percent_decimal ?? null,
    discount_formula: "((base_price - promotion_price) / base_price) * 100",
    base_price_source: contract.base_price_source ?? null,
    promotion_price_source: contract.final_price_source ?? null,
    listing_type: m.listing_type_label ?? ctx.listing_type ?? null,
    fee: m.sale_fee_amount_brl ?? m.fee_amount_brl ?? null,
    freight: m.shipping_cost_amount_brl ?? null,
    seller_receives:
      contract.seller_receives_brl ??
      m.marketplace_payout_amount_brl ??
      m.net_receivable_brl ??
      null,
    profit: res.profit_brl ?? m.margin_amount_brl ?? null,
    margin: res.margin_pct ?? m.margin_percent ?? null,
    source_fields: contract.raw_source_fields ?? null,
    source_confidence: contract.source_confidence ?? null,
    source_warnings: contract.source_warnings ?? null,
  };
}

/** @param {string} stage @param {Record<string, unknown>} payload */
export function logS7PromotionScenarioSsotAudit(stage, payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info(`[S7_PROMOTION_SCENARIO_SSOT_AUDIT] ${stage}`, payload);
}

/**
 * Log unificado de rastreio financeiro por promoção (DEV).
 * @param {string} stage
 * @param {Record<string, unknown>} ctx
 */
export function logS7PiPromoFlowAudit(stage, ctx = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PI_PROMO_FLOW_AUDIT !== "1") return;
  console.info("[S7_PI_PROMO_FLOW_AUDIT]", { stage, ...ctx });
}

/**
 * @param {{
 *   promotion_name?: string | null;
 *   promotion_id?: string | null;
 *   type?: string | null;
 *   ref_id?: string | null;
 *   fin?: ReturnType<typeof resolveOfficialSellerPromotionFinancials> | null;
 *   row?: Record<string, unknown> | null;
 *   marketplace?: Record<string, unknown> | null;
 *   source_field_used?: string | null;
 * }} p
 */
export function buildPiPromoFlowAuditPayload(p) {
  const fin = p.fin ?? null;
  const audit =
    fin?.ml_financial_audit != null && typeof fin.ml_financial_audit === "object"
      ? fin.ml_financial_audit
      : {};
  const m = p.marketplace ?? {};
  const row = p.row ?? {};
  const contract =
    row.promotion_offer_contract != null && typeof row.promotion_offer_contract === "object"
      ? /** @type {Record<string, unknown>} */ (row.promotion_offer_contract)
      : null;
  const res =
    row.result != null && typeof row.result === "object"
      ? /** @type {Record<string, unknown>} */ (row.result)
      : null;
  return {
    listing_id: row.external_listing_id ?? contract?.listing_id ?? null,
    marketplace_account_id: contract?.marketplace_account_id ?? null,
    promotion_name:
      p.promotion_name ??
      row.promotion_name ??
      row.label ??
      row.name ??
      null,
    promotion_id: p.promotion_id ?? audit.promotion_id ?? row.promotion_id ?? row.id ?? null,
    type: p.type ?? audit.type ?? row.promotion_type ?? row.type ?? null,
    ref_id: p.ref_id ?? row.offer_id ?? row.ref_id ?? null,
    original_price: contract?.original_price_brl ?? audit.original_price ?? m.original_price_brl ?? null,
    promotion_price: contract?.final_price_brl ?? audit.promotion_price ?? m.sale_price_brl ?? null,
    seller_percentage: contract?.seller_percentage_raw ?? audit.seller_percentage ?? null,
    meli_percentage: contract?.meli_percentage_raw ?? audit.meli_percentage ?? null,
    discount_seller_brl:
      contract?.discount_amount_brl ??
      audit.discount_seller_brl ??
      fin?.seller_discount_amount_brl ??
      m.seller_discount_amount_brl ??
      null,
    discount_seller_pct:
      contract?.discount_percent_display != null
        ? `${contract.discount_percent_display}.00`
        : audit.ml_discount_pct ?? fin?.seller_discount_percent ?? m.seller_discount_percent ?? null,
    discount_meli_brl: audit.discount_meli_brl ?? fin?.promotion_subsidy_amount_brl ?? m.promotion_subsidy_amount_brl ?? null,
    discount_meli_boost_amount: audit.discount_meli_boost_amount ?? null,
    fee_before_subsidy: m.fee_amount_before_promo_subsidy_brl ?? m.sale_fee_amount_brl ?? m.fee_amount_brl ?? null,
    fee_after_subsidy: m.fee_amount_after_promo_subsidy_brl ?? null,
    shipping_brl: m.shipping_cost_amount_brl ?? null,
    payout: m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? m.payout_after_promo_subsidy_brl ?? null,
    profit: res?.profit_brl ?? m.margin_amount_brl ?? null,
    margin: res?.margin_pct ?? m.margin_percent ?? null,
    promotion_price_source: contract?.final_price_source ?? audit.final_price_source ?? null,
    base_price_source: contract?.base_price_source ?? null,
    source_field_used: p.source_field_used ?? contract?.source_confidence ?? audit.discount_source ?? fin?.promotion_source ?? null,
  };
}

/** @param {Record<string, unknown>} row */
export function extractOfficialPromotionFinancialRawFields(row) {
  const r = row != null && typeof row === "object" ? row : {};
  const name = r.name ?? r.promotion_name ?? r.type ?? null;
  return {
    listing_external_id: r.item_id ?? r.external_listing_id ?? null,
    promotion_id: r.id ?? r.promotion_id ?? null,
    promotion_name: name != null ? String(name) : null,
    original_price: pickFirstRaw(r, ["original_price", "regular_amount", "base_price", "list_price"]),
    promotion_price: pickFirstRaw(r, ["price", "amount", "deal_price"]),
    discount_amount: pickFirstRaw(r, ["discount_amount", "total_discount_amount"]),
    discount_percent: pickFirstRaw(r, ["discount_percentage", "discount_percent", "total_discount_percentage"]),
    seller_discount_amount: pickFirstRaw(r, ["seller_discount_amount", "seller_funded_amount"]),
    marketplace_subsidy_amount: pickFirstRaw(r, [
      "marketplace_subsidy_amount",
      "meli_subsidy_amount",
      "meli_funded_amount",
    ]),
    fee_amount: pickFirstRaw(r, ["fee_amount", "sale_fee_amount", "charged_fee", "final_fee_amount"]),
    original_fee_amount: pickFirstRaw(r, ["original_fee_amount", "gross_fee_amount", "fee_amount_before_discount"]),
    final_fee_amount: pickFirstRaw(r, ["final_fee_amount", "charged_fee", "net_fee_amount", "sale_fee_net"]),
    fee_discount_amount: pickFirstRaw(r, [
      "fee_discount_amount",
      "fee_discount",
      "marketplace_fee_discount_amount",
      "charged_fee_discount",
      "meli_fee_discount",
      "commission_discount_amount",
      "discount_meli_boost_amount",
      "meli_boost_amount",
    ]),
    amount_to_receive: pickFirstRaw(r, [
      "amount_to_receive",
      "net_proceeds",
      "payout",
      "seller_amount",
      "you_receive_amount",
    ]),
    seller_percentage: pickFirstRaw(r, ["seller_percentage", "seller_discount_percentage", "seller_discount_percent"]),
    meli_percentage: pickFirstRaw(r, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"]),
    raw_relevant_keys: Object.keys(r).filter((k) =>
      /price|discount|fee|subsidy|boost|percentage|payout|receive|amount|charged|commission/i.test(k)
    ),
  };
}

/** @param {Record<string, unknown>} row @returns {Decimal | null} */
function resolveOfficialPromotionFeeDiscountDec(row) {
  const explicit = toDec(
    pickFirstRaw(row, [
      "discount_meli_boost_amount",
      "meli_boost_amount",
      "fee_discount_amount",
      "marketplace_fee_discount_amount",
      "charged_fee_discount",
      "fee_discount",
      "meli_fee_discount",
      "commission_discount_amount",
      "fee_discount_amount_brl",
    ])
  );
  if (explicit != null && explicit.gt(0)) return explicit;

  const grossFee = toDec(
    pickFirstRaw(row, ["original_fee_amount", "gross_fee_amount", "fee_amount_before_discount"])
  );
  const netFee = toDec(
    pickFirstRaw(row, ["final_fee_amount", "charged_fee", "net_fee_amount", "sale_fee_net", "sale_fee_amount"])
  );
  if (grossFee != null && netFee != null && grossFee.gte(netFee)) {
    const diff = grossFee.minus(netFee);
    return diff.gt(0) ? diff : null;
  }
  return null;
}

/**
 * Normaliza percentual bruto da API ML (0.12 → 12, 12 → 12, 1200 inválido).
 *
 * @param {unknown} raw
 * @returns {Decimal | null}
 */
function normalizarPercentualApiDecimal(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const dec = toDec(String(raw).replace("%", "").trim());
  if (dec == null || !dec.gt(0)) return null;
  if (dec.lt(1)) {
    const scaled = dec.times(100);
    if (scaled.gte(1) && scaled.lte(100)) return scaled;
    return null;
  }
  if (dec.gt(100)) return null;
  return dec;
}

/**
 * @param {Decimal | null} dec
 * @returns {string | null}
 */
function formatarPercentualExibicaoInteiro(dec) {
  if (dec == null) return null;
  return String(Math.round(dec.toDecimalPlaces(2, ROUND).toNumber()));
}

/**
 * Desconto comercial da promoção — SSOT alinhada à UI ML (original_price − final_price).
 * seller_percentage é preservado apenas em audit.
 *
 * @param {{
 *   rawRow?: Record<string, unknown>;
 *   listingExternalId?: string | null;
 *   promotionId?: string | null;
 *   promotionName?: string | null;
 * }} ctx
 */
export function resolveOfficialPromotionSellerDiscount(ctx) {
  const row = ctx.rawRow != null && typeof ctx.rawRow === "object" ? ctx.rawRow : {};
  const ui = resolvePromotionUiFinancials(row);

  const sellerPctRaw = ui.seller_percentage_raw;
  const auditPayload = {
    listing_external_id: ctx.listingExternalId ?? null,
    promotion_id: ctx.promotionId ?? row.id ?? row.promotion_id ?? null,
    promotion_name: ctx.promotionName ?? row.name ?? row.promotion_name ?? null,
    original_price_brl: ui.original_price_brl,
    price_raw: ui.price_raw,
    boosted_offer: ui.boosted_offer,
    total_price_for_boosted_offer_raw: ui.total_price_for_boosted_offer_raw,
    final_price_used: ui.final_price_brl,
    final_price_source: ui.final_price_source,
    raw_seller_percentage: sellerPctRaw ?? null,
    raw_meli_percentage: ui.meli_percentage_raw ?? null,
    calculated_discount_amount: ui.discount_amount_brl,
    calculated_discount_percent: ui.discount_percent_decimal,
    discount_percent_display: ui.discount_percent_display,
    chosen_discount_amount: ui.discount_amount_brl,
    chosen_discount_percent: ui.discount_percent_display,
    chosen_source: ui.discount_source,
    source_confidence: ui.source_confidence,
  };
  logS7PromotionsPiAudit("seller_discount_resolution", auditPayload);

  const chosenPercentStr =
    ui.discount_percent_display != null ? `${ui.discount_percent_display}.00` : null;

  return {
    seller_discount_amount_brl: ui.discount_amount_brl,
    seller_discount_percent: chosenPercentStr,
    seller_discount_percent_display: ui.discount_percent_display,
    discount_source: ui.discount_source,
    audit: auditPayload,
    ui_financials: ui,
  };
}

/**
 * Campos financeiros SSOT — preço comprador, tarifa bruta/líquida, redução ML, você recebe.
 *
 * @param {{
 *   rawRow?: Record<string, unknown>;
 *   buyerFinalPriceBrl?: string | null;
 *   feeRatePercent?: string | null;
 *   grossFeeBrl?: string | null;
 *   freightCostBrl?: string | null;
 *   feeReductionBrl?: string | null;
 *   feeReductionSource?: string | null;
 *   sellerReceivesBrl?: string | null;
 * }} ctx
 */
export function buildPromotionFinancialSsotFields(ctx) {
  const rawObj =
    ctx.rawRow != null && typeof ctx.rawRow === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.rawRow)
      : /** @type {Record<string, unknown>} */ ({});
  const ui = resolvePromotionUiFinancials(rawObj);
  const originalDec = toDec(ui.original_price_brl);
  const buyerFinalDec =
    toDec(ctx.buyerFinalPriceBrl ?? ui.final_price_brl) ?? toDec(ui.final_price_brl);

  let discountAmountDec = null;
  let discountPercentDec = null;
  if (originalDec != null && buyerFinalDec != null && originalDec.gt(buyerFinalDec)) {
    discountAmountDec = originalDec.minus(buyerFinalDec);
    if (originalDec.gt(0)) {
      discountPercentDec = discountAmountDec.times(100).div(originalDec);
    }
  }

  const feeRateDec = toDec(ctx.feeRatePercent);
  let grossFeeDec = toDec(ctx.grossFeeBrl);
  if (grossFeeDec == null && buyerFinalDec != null && feeRateDec != null && feeRateDec.gt(0)) {
    grossFeeDec = buyerFinalDec.times(feeRateDec).div(100);
  }

  const boostRaw = pickFirstRaw(rawObj, ["discount_meli_boost_amount", "meli_boost_amount"]);
  const boostPctRaw = pickFirstRaw(rawObj, [
    "discount_meli_boosted_percentage",
    "meli_boosted_percentage",
  ]);

  let feeReductionDec = toDec(ctx.feeReductionBrl);
  let feeReductionSource = ctx.feeReductionSource ?? null;
  if (feeReductionDec == null || !feeReductionDec.gt(0)) {
    feeReductionDec = resolveOfficialPromotionFeeDiscountDec(rawObj);
    if (feeReductionDec != null && feeReductionDec.gt(0)) {
      feeReductionSource =
        boostRaw != null ? "discount_meli_boost_amount" : "official_fee_discount_field";
    }
  }
  if (feeReductionDec == null || !feeReductionDec.gt(0)) {
    feeReductionDec = new Decimal(0);
    feeReductionSource = feeReductionSource ?? "none";
  }

  const netFeeDec =
    grossFeeDec != null ? Decimal.max(0, grossFeeDec.minus(feeReductionDec)) : null;
  const freightDec = toDec(ctx.freightCostBrl) ?? new Decimal(0);

  let sellerReceivesDec = toDec(ctx.sellerReceivesBrl);
  if (sellerReceivesDec == null) {
    const officialReceive = toDec(
      pickFirstRaw(rawObj, [
        "amount_to_receive",
        "net_proceeds",
        "payout",
        "seller_amount",
        "you_receive_amount",
      ])
    );
    if (officialReceive != null) {
      sellerReceivesDec = officialReceive;
    } else if (buyerFinalDec != null && netFeeDec != null) {
      sellerReceivesDec = buyerFinalDec.minus(netFeeDec).minus(freightDec);
    }
  }

  return {
    original_price_brl: ui.original_price_brl,
    buyer_final_price_brl: buyerFinalDec != null ? decStr2(buyerFinalDec) : ui.final_price_brl,
    final_price_brl: buyerFinalDec != null ? decStr2(buyerFinalDec) : ui.final_price_brl,
    final_price_source: ui.final_price_source,
    discount_amount_brl: discountAmountDec != null ? decStr2(discountAmountDec) : ui.discount_amount_brl,
    discount_percent_decimal:
      discountPercentDec != null ? decStr2(discountPercentDec) : ui.discount_percent_decimal,
    discount_percent: formatarPercentualExibicaoInteiro(discountPercentDec ?? toDec(ui.discount_percent_display)),
    discount_percent_display:
      formatarPercentualExibicaoInteiro(discountPercentDec ?? toDec(ui.discount_percent_display)) ??
      ui.discount_percent_display,
    marketplace_fee_rate_percent: feeRateDec != null ? decStr2(feeRateDec) : null,
    marketplace_fee_gross_brl: grossFeeDec != null ? decStr2(grossFeeDec) : null,
    marketplace_fee_reduction_brl: feeReductionDec.gt(0) ? decStr2(feeReductionDec) : "0.00",
    marketplace_fee_reduction_source: feeReductionSource,
    marketplace_fee_net_brl: netFeeDec != null ? decStr2(netFeeDec) : null,
    freight_cost_brl: decStr2(freightDec),
    seller_receives_brl: sellerReceivesDec != null ? decStr2(sellerReceivesDec) : null,
    boosted_offer: ui.boosted_offer === true,
    discount_meli_boosted_percentage: boostPctRaw ?? null,
    discount_meli_boost_amount: boostRaw ?? (feeReductionDec.gt(0) ? decStr2(feeReductionDec) : null),
    total_price_for_boosted_offer: ui.total_price_for_boosted_offer_raw ?? null,
    fee_reduction_source: feeReductionSource,
    source_fields: extractOfficialPromotionFinancialRawFields(rawObj),
  };
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionFinancialSsotAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_FINANCIAL_SSOT_AUDIT]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionPriceOnlyAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_PRICE_ONLY_AUDIT]", payload);
}

/**
 * Contrato mínimo PI — somente nome, preço original, preço final real e desconto derivado.
 * Não inclui tarifa, subsídio, payout ou margem.
 *
 * @param {{
 *   listingExternalId?: string | null;
 *   marketplaceAccountId?: string | null;
 *   promotionRow?: Record<string, unknown> | null;
 *   normalizedPromotion?: Record<string, unknown> | null;
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   sameListingPromotionRows?: Record<string, unknown>[];
 *   listingContext?: {
 *     variations_count?: number | null;
 *     raw_json?: Record<string, unknown> | null;
 *   };
 *   enrichmentItemRows?: Record<string, unknown>[] | null;
 *   liveFetchOk?: boolean;
 *   promotionPayloadSource?: string | null;
 *   payloadLiveReceivedAt?: string | null;
 *   cacheHit?: boolean;
 *   promotionPayloadAgeMs?: number | null;
 *   promotionPayloadStaleBlocked?: boolean;
 *   promotionPayloadSignature?: string | null;
 * }} ctx
 */
export function buildPromotionCardContract(ctx) {
  const pr = ctx.normalizedPromotion ?? {};
  const rawRow =
    ctx.promotionRow ??
    (pr.ml_api_raw_row != null && typeof pr.ml_api_raw_row === "object" ? pr.ml_api_raw_row : {});
  const rawObj =
    rawRow != null && typeof rawRow === "object"
      ? /** @type {Record<string, unknown>} */ (rawRow)
      : /** @type {Record<string, unknown>} */ ({});
  const structuralDenylist = ctx.structuralAnonymousPriceDenylist ?? new Set();
  const sourceIdentityKey = buildOfficialSellerPromotionListDedupeKey(rawObj);
  const sameListingOtherPromotionPrices = collectSameListingOtherPromotionPrices(
    rawObj,
    ctx.sameListingPromotionRows ?? [],
    structuralDenylist
  );

  const ui = resolvePromotionUiFinancials(rawObj, {
    structuralAnonymousPriceDenylist: structuralDenylist,
    sameListingOtherPromotionPrices,
    sameListingSiblingRows: ctx.sameListingPromotionRows ?? [],
    listingId:
      ctx.listingExternalId ??
      (rawObj.item_id != null ? String(rawObj.item_id) : null) ??
      (rawObj.listing_id != null ? String(rawObj.listing_id) : null) ??
      null,
    variationId: rawObj.variation_id != null ? String(rawObj.variation_id) : null,
    listingContext: ctx.listingContext ?? null,
    enrichmentItemRows: ctx.enrichmentItemRows ?? null,
  });
  const basePriceSource = pickOriginalPriceFieldName(rawObj);
  const offerId =
    pr.offer_id ??
    (rawObj.ref_id != null ? String(rawObj.ref_id) : null) ??
    (rawObj.offer_id != null ? String(rawObj.offer_id) : null) ??
    null;
  const subType =
    rawObj.sub_type != null && String(rawObj.sub_type).trim() !== ""
      ? String(rawObj.sub_type).trim()
      : null;
  const suggestedDec = pickValidFinalBelowOriginal(
    toDec(rawObj.suggested_discounted_price),
    pickOriginalPriceDec(rawObj)
  );
  const contaminatedByAnonymous =
    ui.final_price_source === "suggested_discounted_price" &&
    suggestedDec != null &&
    priceMatchesStructuralAnonymousDenylist(suggestedDec, structuralDenylist);

  const payloadMeta = buildPromotionLivePayloadMeta({
    rawRow: rawObj,
    pipelinePromoSource:
      ctx.promotionPayloadStaleBlocked === true
        ? "cache_stale_blocked"
        : ctx.promotionPayloadSource === "live" || ctx.promotionPayloadSource === "live_api"
          ? "live_api"
          : ctx.promotionPayloadSource ?? (ctx.liveFetchOk === true ? "live_api" : null),
    liveFetchOk: ctx.liveFetchOk === true || ctx.promotionPayloadSource === "live",
    payloadReceivedAt: ctx.payloadLiveReceivedAt ?? null,
    cacheHit: ctx.cacheHit === true,
    cacheAgeMs: ctx.promotionPayloadAgeMs ?? null,
    blockedStale: ctx.promotionPayloadStaleBlocked === true,
  });

  if (ctx.promotionPayloadSignature != null && payloadMeta.promotion_payload_signature == null) {
    payloadMeta.promotion_payload_signature = ctx.promotionPayloadSignature;
  }

  const selectedSourcePath =
    ui.panel_parity?.selected_source_path ??
    ui.final_price_source ??
    "resolution_unknown";

  const contract = {
    listing_id:
      ctx.listingExternalId ??
      (rawObj.item_id != null ? String(rawObj.item_id) : null) ??
      (rawObj.listing_id != null ? String(rawObj.listing_id) : null) ??
      null,
    marketplace_account_id: ctx.marketplaceAccountId ?? null,
    promotion_id:
      pr.promotion_id ??
      (rawObj.id != null ? String(rawObj.id) : null) ??
      (rawObj.promotion_id != null ? String(rawObj.promotion_id) : null) ??
      null,
    offer_id: offerId,
    promotion_name:
      pr.promotion_name ??
      (rawObj.name != null ? String(rawObj.name) : null) ??
      (rawObj.promotion_name != null ? String(rawObj.promotion_name) : null) ??
      null,
    promotion_type:
      pr.promotion_type ??
      (rawObj.type != null ? String(rawObj.type) : null) ??
      (rawObj.promotion_type != null ? String(rawObj.promotion_type) : null) ??
      null,
    sub_type: subType,
    original_price_brl: ui.original_price_brl,
    real_promotion_final_price_brl: ui.final_price_brl,
    final_price_source: ui.final_price_source,
    discount_amount_brl: ui.discount_amount_brl,
    discount_percent_display: ui.discount_percent_display,
    source_identity_key: sourceIdentityKey,
    contaminated_by_anonymous_price_discount: contaminatedByAnonymous,
    source_warnings: ui.source_warnings ?? [],
    variation_linkage_v1: ui.variation_linkage_v1 ?? null,
    selected_final_price: ui.panel_parity?.selected_final_price ?? ui.final_price_brl,
    raw_final_price_from_ml: ui.panel_parity?.raw_final_price_from_ml ?? null,
    selected_discount_amount: ui.panel_parity?.selected_discount_amount ?? ui.discount_amount_brl,
    raw_discount_amount_from_ml: ui.panel_parity?.raw_discount_amount_from_ml ?? null,
    selected_discount_percent: ui.panel_parity?.selected_discount_percent ?? ui.discount_percent_display,
    selected_source_path: selectedSourcePath,
    selected_rule: ui.panel_parity?.selected_rule ?? null,
    selected_variation_id: ui.panel_parity?.selected_variation_id ?? null,
    has_variation_range: ui.panel_parity?.has_variation_range ?? false,
    is_ambiguous: ui.panel_parity?.is_ambiguous ?? false,
    warning_codes: ui.panel_parity?.warning_codes ?? [],
    source_trace: ui.panel_parity?.source_trace ?? [],
    promotion_price_candidates: ui.panel_parity?.promotion_price_candidates ?? [],
    payout_brl: ui.panel_parity?.payout_brl ?? null,
    payload_live_received_at: payloadMeta.payload_live_received_at,
    promotion_payload_source: payloadMeta.promotion_payload_source,
    promotion_payload_age_ms: payloadMeta.promotion_payload_age_ms,
    promotion_payload_signature: payloadMeta.promotion_payload_signature,
    promotion_payload_ttl_ms: payloadMeta.promotion_payload_ttl_ms,
    promotion_payload_stale_blocked: payloadMeta.promotion_payload_stale_blocked === true,
    selected_source: selectedSourcePath,
    source_fields: {
      ...extractOfficialPromotionFinancialRawFields(rawObj),
      base_price_source: basePriceSource,
      price_raw: ui.price_raw ?? null,
      suggested_discounted_price_raw: rawObj.suggested_discounted_price ?? null,
      max_discounted_price_raw: rawObj.max_discounted_price ?? null,
      min_discounted_price_raw: rawObj.min_discounted_price ?? null,
      total_price_for_boosted_offer_raw: ui.total_price_for_boosted_offer_raw ?? null,
      boosted_offer: ui.boosted_offer === true,
      discount_formula: "original_price_brl - real_promotion_final_price_brl",
    },
  };

  emitPromotionFinalParityDecisionLogs({
    listingId: contract.listing_id,
    promotionId: contract.promotion_id,
    promotionName: contract.promotion_name,
    cardContract: contract,
    payloadMeta,
    panelAudit: ui.panel_parity ?? null,
  });

  if (isS7PromotionDebugEnabled()) {
    const candidates = ui.panel_parity?.promotion_price_candidates ?? [];
    logS7PromotionDebugParity({
      listing_id: contract.listing_id,
      promotion_id: contract.promotion_id,
      promotion_name: contract.promotion_name,
      monetary_candidates: candidates,
      selected_source: contract.selected_source,
      selected_rule: contract.selected_rule,
      discard_trace: ui.panel_parity?.source_trace ?? [],
      promotion_payload_source: payloadMeta.promotion_payload_source,
      promotion_payload_age_ms: payloadMeta.promotion_payload_age_ms,
      from_live: ctx.liveFetchOk === true || payloadMeta.promotion_payload_source === "live",
      payload_signature: payloadMeta.promotion_payload_signature,
    });
  }

  return enrichPromotionContractWithFunding(contract, rawObj, {
    listing_id: contract.listing_id,
    promotion_id: contract.promotion_id,
    promotion_name: contract.promotion_name,
    promotion_type: contract.promotion_type,
  });
}

/**
 * Contrato canônico SSOT — promoção por anúncio (mini cards + cards Clássico/Premium).
 *
 * @param {{
 *   listingExternalId?: string | null;
 *   promotionRow?: Record<string, unknown> | null;
 *   normalizedPromotion?: Record<string, unknown> | null;
 *   financials?: ReturnType<typeof resolveOfficialSellerPromotionFinancials> | null;
 *   listingCatalogPriceBrl?: string | null;
 *   marketplaceAccountId?: string | null;
 *   scenarioMarketplace?: Record<string, unknown> | null;
 *   presentation?: ReturnType<typeof resolveOfficialPromotionPresentationFinancials> | null;
 * }} ctx
 */
export function buildCanonicalPromotionOfferContract(ctx) {
  const pr = ctx.normalizedPromotion ?? {};
  const fin = ctx.financials ?? null;
  const rawRow =
    ctx.promotionRow ??
    (pr.ml_api_raw_row != null && typeof pr.ml_api_raw_row === "object" ? pr.ml_api_raw_row : {});
  const rawObj =
    rawRow != null && typeof rawRow === "object"
      ? /** @type {Record<string, unknown>} */ (rawRow)
      : /** @type {Record<string, unknown>} */ ({});
  const audit =
    fin?.ml_financial_audit != null && typeof fin.ml_financial_audit === "object"
      ? /** @type {Record<string, unknown>} */ (fin.ml_financial_audit)
      : /** @type {Record<string, unknown>} */ ({});
  const mScenario =
    ctx.scenarioMarketplace != null && typeof ctx.scenarioMarketplace === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.scenarioMarketplace)
      : /** @type {Record<string, unknown>} */ ({});
  const presentation = ctx.presentation ?? null;

  const rawFields = extractOfficialPromotionFinancialRawFields(rawObj);
  const ui = resolvePromotionUiFinancials(rawObj);
  const grossFeeFromScenario =
    mScenario.sale_fee_amount_brl ??
    mScenario.fee_amount_brl ??
    mScenario.fee_amount_before_promo_subsidy_brl ??
    presentation?.gross_fee_brl ??
    null;
  const feeRateFromScenario =
    mScenario.sale_fee_percent != null ? String(mScenario.sale_fee_percent) : null;
  const freightFromScenario =
    mScenario.shipping_cost_amount_brl != null ? String(mScenario.shipping_cost_amount_brl) : null;

  const financialSsot = buildPromotionFinancialSsotFields({
    rawRow: rawObj,
    buyerFinalPriceBrl: ui.final_price_brl,
    feeRatePercent: feeRateFromScenario,
    grossFeeBrl: grossFeeFromScenario != null ? String(grossFeeFromScenario) : null,
    freightCostBrl: freightFromScenario,
    feeReductionBrl: presentation?.fee_discount_brl ?? fin?.fee_discount_brl ?? null,
    feeReductionSource: presentation?.fee_discount_source ?? audit.fee_discount_source ?? null,
    sellerReceivesBrl:
      presentation?.expected_payout_brl ??
      mScenario.marketplace_payout_amount_brl ??
      mScenario.net_receivable_brl ??
      null,
  });
  const startDate =
    pr.starts_at ??
    toIsoDateStringOrNull(
      pickFirstRaw(rawObj, ["start_date", "start_time", "date_from", "starts_at"])
    );
  const endDate =
    pr.ends_at ??
    toIsoDateStringOrNull(
      pickFirstRaw(rawObj, [
        "finish_date",
        "end_date",
        "date_to",
        "finish_time",
        "ends_at",
        "stop_time",
      ])
    );

  const basePriceSource = pickOriginalPriceFieldName(rawObj);

  const offerContract = {
    marketplace: "mercado_livre",
    marketplace_account_id: ctx.marketplaceAccountId ?? null,
    listing_id: ctx.listingExternalId ?? rawFields.listing_external_id ?? null,
    promotion_id: pr.promotion_id ?? audit.promotion_id ?? rawFields.promotion_id ?? null,
    promotion_name: pr.promotion_name ?? rawFields.promotion_name ?? null,
    promotion_type: pr.promotion_type ?? audit.type ?? null,
    offer_id: pr.offer_id ?? null,
    is_lightning: tipoIndicaRelampagoPromocao(pr.promotion_type ?? audit.type ?? rawObj.type),
    participation_status: pr.status ?? null,
    ml_raw_status: pr.raw_status ?? null,
    action_kind:
      pr.promotion_active === true || pr.ml_effective_state === "active"
        ? "alterar"
        : pr.ml_effective_state === "scheduled"
          ? "programado"
          : "participar",
    start_date: startDate,
    end_date: endDate,
    original_price_brl: financialSsot.original_price_brl ?? ui.original_price_brl ?? audit.original_price ?? pr.reference_price_brl ?? null,
    base_price_source: basePriceSource,
    buyer_final_price_brl: financialSsot.buyer_final_price_brl,
    final_price_brl: financialSsot.final_price_brl ?? ui.final_price_brl ?? pr.final_price_brl ?? audit.promotion_price ?? null,
    final_price_source: financialSsot.final_price_source ?? ui.final_price_source ?? null,
    discount_formula: "((original_price_brl - buyer_final_price_brl) / original_price_brl) * 100",
    discount_amount_brl: financialSsot.discount_amount_brl ?? ui.discount_amount_brl ?? fin?.seller_discount_amount_brl ?? null,
    discount_percent_decimal: financialSsot.discount_percent_decimal ?? ui.discount_percent_decimal ?? null,
    discount_percent: financialSsot.discount_percent ?? ui.discount_percent_display ?? fin?.seller_discount_percent_display ?? null,
    discount_percent_display:
      financialSsot.discount_percent_display ?? ui.discount_percent_display ?? fin?.seller_discount_percent_display ?? null,
    marketplace_fee_rate_percent: financialSsot.marketplace_fee_rate_percent,
    marketplace_fee_gross_brl: financialSsot.marketplace_fee_gross_brl,
    marketplace_fee_reduction_brl: financialSsot.marketplace_fee_reduction_brl,
    marketplace_fee_reduction_source: financialSsot.marketplace_fee_reduction_source,
    marketplace_fee_net_brl: financialSsot.marketplace_fee_net_brl,
    freight_cost_brl: financialSsot.freight_cost_brl,
    seller_receives_brl: financialSsot.seller_receives_brl,
    seller_percentage_raw: ui.seller_percentage_raw ?? audit.seller_percentage ?? rawFields.seller_percentage ?? null,
    meli_percentage_raw: ui.meli_percentage_raw ?? audit.meli_percentage ?? rawFields.meli_percentage ?? null,
    boosted_offer: financialSsot.boosted_offer === true,
    discount_meli_boosted_percentage: financialSsot.discount_meli_boosted_percentage,
    discount_meli_boost_amount: financialSsot.discount_meli_boost_amount,
    total_price_for_boosted_offer_raw: financialSsot.total_price_for_boosted_offer ?? ui.total_price_for_boosted_offer_raw ?? null,
    fee_reduction_source: financialSsot.fee_reduction_source,
    marketplace_fee_brl: financialSsot.marketplace_fee_reduction_brl,
    listing_catalog_price_brl: ctx.listingCatalogPriceBrl ?? null,
    price_applied: pr.price_applied === true,
    discount_source: ui.discount_source ?? audit.discount_source ?? null,
    raw_source_fields: rawFields,
    source_confidence: ui.source_confidence ?? audit.discount_source ?? fin?.promotion_source ?? null,
    source_warnings: [
      ...(ui.source_warnings ?? []),
      ...(fin?.is_promotion_estimated === true ? ["promotion_price_estimated_or_not_applied"] : []),
    ],
  };

  return enrichPromotionContractWithFunding(offerContract, rawObj, {
    listing_id: offerContract.listing_id,
    promotion_id: offerContract.promotion_id,
    promotion_name: offerContract.promotion_name,
    promotion_type: offerContract.promotion_type,
  });
}

/**
 * @param {unknown} typeValue
 * @returns {boolean}
 */
export function tipoIndicaRelampagoPromocao(typeValue) {
  const s = typeValue != null ? String(typeValue).trim().toLowerCase() : "";
  if (s === "") return false;
  return s.includes("lightning") || s.includes("relampago") || s.includes("relâmpago") || s.includes("flash");
}

/**
 * Desconto seller / subsídio ML a partir do payload oficial GET /seller-promotions/items.
 *
 * Separação obrigatória:
 * - discount_seller_brl: desconto comercial de preço (fecha original − promo).
 * - fee_discount_brl / promotion_subsidy_amount_brl: redução de tarifa ML (NUNCA meli_percentage × preço).
 * - discount_total_brl: original − promotion_price (referência).
 *
 * @param {Record<string, unknown>} row
 * @param {string | null | undefined} promoPriceBrl
 * @param {string | null | undefined} referencePriceBrl
 * @param {{
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 *   listingId?: string | null;
 *   listingContext?: {
 *     variations_count?: number | null;
 *     has_listing_variations?: boolean | null;
 *     raw_json?: Record<string, unknown> | null;
 *   };
 * }} [opts]
 */
export function resolveOfficialSellerPromotionFinancials(row, promoPriceBrl, referencePriceBrl, opts = {}) {
  const ui = resolvePromotionUiFinancials(row, opts);

  const meliPctRaw = pickFirstRaw(row, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"]);
  const meliPct =
    meliPctRaw != null && String(meliPctRaw).trim() !== "" ? toDec(meliPctRaw) : null;
  const catalogOriginalDec = toDec(referencePriceBrl) ?? pickOriginalPriceDec(row);

  /** Redução de tarifa ML — somente campos oficiais de fee discount (nunca meli_percentage × preço). */
  const feeDiscountDec = resolveOfficialPromotionFeeDiscountDec(row);
  let feeDiscountSource = feeDiscountDec != null ? "official_fee_discount_field" : null;
  if (feeDiscountDec != null && pickFirstRaw(row, ["discount_meli_boost_amount", "meli_boost_amount"]) != null) {
    feeDiscountSource = "discount_meli_boost_amount";
  }

  /** Co-financiamento de preço (audit only — não entra como subsídio de tarifa). */
  const meliPriceCoFundingDec =
    meliPct != null && catalogOriginalDec != null && catalogOriginalDec.gt(0)
      ? catalogOriginalDec.times(meliPct).div(100)
      : null;

  const sellerResolved = resolveOfficialPromotionSellerDiscount({
    rawRow: row,
    promotionId: row.id != null ? String(row.id) : row.promotion_id != null ? String(row.promotion_id) : null,
    promotionName:
      row.name != null
        ? String(row.name)
        : row.promotion_name != null
          ? String(row.promotion_name)
          : null,
  });

  const boostedOffer = row.boosted_offer === true;
  const totalBoosted = toDec(row.total_price_for_boosted_offer);
  const feeDiscountBrl = feeDiscountDec != null ? decStr2(feeDiscountDec) : null;
  const sellerPctRaw = ui.seller_percentage_raw;

  return {
    promotion_subsidy_amount_brl: feeDiscountBrl,
    fee_discount_brl: feeDiscountBrl,
    seller_discount_amount_brl: ui.discount_amount_brl,
    seller_discount_percent: ui.discount_percent_display != null ? `${ui.discount_percent_display}.00` : null,
    seller_discount_percent_display: ui.discount_percent_display,
    promotion_source: `ml_seller_promotions_api:${ui.discount_source}`,
    is_promotion_estimated: ui.source_confidence !== "official_item_promotion_price",
    ml_financial_audit: {
      promotion_id: row.id ?? row.promotion_id ?? null,
      type: row.type ?? row.promotion_type ?? null,
      original_price: ui.original_price_brl,
      promotion_price: ui.final_price_brl,
      final_price_source: ui.final_price_source,
      seller_percentage: sellerPctRaw ?? null,
      meli_percentage: meliPctRaw ?? null,
      discount_seller_brl: ui.discount_amount_brl,
      discount_meli_brl: feeDiscountBrl,
      discount_meli_price_co_funding_brl:
        meliPriceCoFundingDec != null ? decStr2(meliPriceCoFundingDec) : null,
      discount_total_brl: ui.discount_amount_brl,
      boosted_offer: boostedOffer,
      discount_meli_boost_amount:
        pickFirstRaw(row, ["discount_meli_boost_amount", "meli_boost_amount"]) ?? null,
      total_price_for_boosted_offer: totalBoosted != null ? decStr2(totalBoosted) : null,
      fee_discount_brl: feeDiscountBrl,
      fee_discount_source: feeDiscountSource,
      meli_subsidy_source: feeDiscountSource,
      discount_source: ui.discount_source,
      ml_discount_brl: ui.discount_amount_brl,
      ml_discount_pct: ui.discount_percent_display != null ? `${ui.discount_percent_display}.00` : null,
      discount_percent_decimal: ui.discount_percent_decimal,
      discount_percent_display: ui.discount_percent_display,
      promotion_ui_financials: ui,
      seller_discount_resolution: sellerResolved.audit,
      amount_to_receive: pickFirstRaw(row, ["amount_to_receive", "net_proceeds", "payout"]) ?? null,
    },
  };
}

/**
 * Fecha payout/subídio de tarifa quando temos tarifa bruta do cenário + raw da promoção.
 * @param {{
 *   grossFeeBrl?: string | null;
 *   salePriceBrl?: string | null;
 *   shippingCostBrl?: string | null;
 *   fin?: ReturnType<typeof resolveOfficialSellerPromotionFinancials> | null;
 *   rawRow?: Record<string, unknown> | null;
 * }} ctx
 */
export function resolveOfficialPromotionPresentationFinancials(ctx) {
  const priceDec = toDec(ctx.salePriceBrl);
  const grossFee = toDec(ctx.grossFeeBrl);
  const shipDec = toDec(ctx.shippingCostBrl);
  const fin = ctx.fin ?? null;
  const rawRow = ctx.rawRow != null && typeof ctx.rawRow === "object" ? ctx.rawRow : {};

  let feeDiscount = toDec(fin?.fee_discount_brl ?? fin?.promotion_subsidy_amount_brl);
  let feeDiscountSource = fin?.ml_financial_audit?.fee_discount_source ?? "normalized_financials";

  const officialPayout = toDec(
    pickFirstRaw(rawRow, ["amount_to_receive", "net_proceeds", "payout", "seller_amount", "you_receive_amount"])
  );

  if (feeDiscount == null && grossFee != null && officialPayout != null && priceDec != null && shipDec != null) {
    const impliedNetFee = priceDec.minus(officialPayout).minus(shipDec);
    if (impliedNetFee.gte(0) && impliedNetFee.lte(grossFee.plus(0.02))) {
      feeDiscount = grossFee.minus(impliedNetFee);
      feeDiscountSource = "derived_from_amount_to_receive";
    }
  }

  if (feeDiscount == null && grossFee != null) {
    const derived = resolveOfficialPromotionFeeDiscountDec(rawRow);
    if (derived != null) {
      feeDiscount = derived;
      feeDiscountSource = "raw_row_fee_discount_fields";
    }
  }

  const grossFeeStr = grossFee != null ? decStr2(grossFee) : null;
  const feeDiscountStr = feeDiscount != null ? decStr2(feeDiscount) : null;
  const netFeeDec =
    grossFee != null && feeDiscount != null
      ? Decimal.max(0, grossFee.minus(feeDiscount))
      : grossFee;

  let expectedPayout = officialPayout;
  let calculatedPayout = null;
  if (priceDec != null && grossFee != null && shipDec != null) {
    calculatedPayout = priceDec.minus(grossFee).plus(feeDiscount ?? new Decimal(0)).minus(shipDec);
    if (expectedPayout == null) expectedPayout = calculatedPayout;
  }

  const payoutDiff =
    expectedPayout != null && calculatedPayout != null
      ? expectedPayout.minus(calculatedPayout).abs()
      : null;

  return {
    gross_fee_brl: grossFeeStr,
    fee_discount_brl: feeDiscountStr,
    net_fee_brl: netFeeDec != null ? decStr2(netFeeDec) : null,
    shipping_cost_brl: shipDec != null ? decStr2(shipDec) : ctx.shippingCostBrl ?? null,
    seller_discount_brl: fin?.seller_discount_amount_brl ?? null,
    marketplace_subsidy_brl: feeDiscountStr,
    expected_payout_brl: expectedPayout != null ? decStr2(expectedPayout) : null,
    calculated_payout_brl: calculatedPayout != null ? decStr2(calculatedPayout) : null,
    payout_diff_brl: payoutDiff != null && payoutDiff.gt(0.02) ? decStr2(payoutDiff) : "0.00",
    fee_discount_source: feeDiscountSource,
    sale_price_brl: priceDec != null ? decStr2(priceDec) : ctx.salePriceBrl ?? null,
    original_price_brl: fin?.ml_financial_audit?.original_price ?? null,
    final_price_brl: priceDec != null ? decStr2(priceDec) : ctx.salePriceBrl ?? null,
  };
}

/** @param {Record<string, unknown>} row @param {ReturnType<typeof resolveOfficialSellerPromotionFinancials>} fin @param {Record<string, unknown>} marketplace */
export function logS7PiPromoFinAuditDeep(row, fin, marketplace = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PI_PROMO_FIN_AUDIT !== "1") return;
  const audit =
    fin?.ml_financial_audit != null && typeof fin.ml_financial_audit === "object"
      ? fin.ml_financial_audit
      : {};
  const m = marketplace;
  const feeBefore =
    m.fee_amount_before_promo_subsidy_brl ?? m.sale_fee_amount_brl ?? m.fee_amount_brl ?? null;
  const feeAfter = m.fee_amount_after_promo_subsidy_brl ?? null;
  const payoutBefore = m.payout_before_promo_subsidy_brl ?? null;
  const payoutAfter =
    m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? m.payout_after_promo_subsidy_brl ?? null;

  console.info("[S7_PI_PROMO_FIN_AUDIT_DEEP]", {
    promotion_id: audit.promotion_id ?? row.promotion_id ?? null,
    type: audit.type ?? row.promotion_type ?? null,
    original_price: audit.original_price ?? null,
    promotion_price: audit.promotion_price ?? null,
    seller_percentage: audit.seller_percentage ?? null,
    meli_percentage: audit.meli_percentage ?? null,
    discount_seller_brl: audit.discount_seller_brl ?? fin?.seller_discount_amount_brl ?? null,
    discount_meli_brl: audit.discount_meli_brl ?? fin?.promotion_subsidy_amount_brl ?? null,
    discount_total_brl: audit.discount_total_brl ?? null,
    boosted_offer: audit.boosted_offer ?? null,
    discount_meli_boost_amount: audit.discount_meli_boost_amount ?? null,
    total_price_for_boosted_offer: audit.total_price_for_boosted_offer ?? null,
    fee_before_subsidy: feeBefore,
    fee_after_subsidy: feeAfter,
    payout_before_subsidy: payoutBefore,
    payout_after_subsidy: payoutAfter,
    meli_subsidy_source: audit.meli_subsidy_source ?? null,
    discount_source: audit.discount_source ?? null,
  });
}

/**
 * @param {Record<string, unknown>} row
 * @param {{
 *   source?: "live" | "persisted";
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 *   skipLiquidaCaseAudit?: boolean;
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   listingId?: string | null;
 *   listingContext?: {
 *     variations_count?: number | null;
 *     has_listing_variations?: boolean | null;
 *     raw_json?: Record<string, unknown> | null;
 *   };
 * }} [opts]
 */
export function normalizeOfficialSellerPromotionRow(row, opts = {}) {
  const source = opts.source === "persisted" ? "persisted" : "live";
  const promotionId = pickOfficialPromotionIdFromRawRow(row);
  const promotionType =
    row.type != null && String(row.type).trim() !== ""
      ? String(row.type).trim()
      : row.promotion_type != null && String(row.promotion_type).trim() !== ""
        ? String(row.promotion_type).trim()
        : row.sub_type != null && String(row.sub_type).trim() !== ""
          ? String(row.sub_type).trim()
          : null;
  const offerId =
    row.ref_id != null && String(row.ref_id).trim() !== ""
      ? String(row.ref_id).trim()
      : row.offer_id != null && String(row.offer_id).trim() !== ""
        ? String(row.offer_id).trim()
        : null;
  const statusPack = classifyOfficialMlSellerPromotionStatus(row.status);
  const prices = resolveOfficialSellerPromotionPrices(row, {
    sameListingOtherPromotionPrices: opts.sameListingOtherPromotionPrices,
    sameListingSiblingRows: opts.sameListingSiblingRows,
    skipLiquidaCaseAudit: opts.skipLiquidaCaseAudit,
    structuralAnonymousPriceDenylist: opts.structuralAnonymousPriceDenylist,
    listingId: opts.listingId ?? null,
    listingContext: opts.listingContext ?? null,
  });
  const nameRaw = row.name ?? row.promotion_name ?? row.type ?? row.promotion_type;
  const promotionName =
    nameRaw != null && String(nameRaw).trim() !== ""
      ? String(nameRaw).trim()
      : promotionId !== ""
        ? `Promoção ${promotionId}`
        : "Promoção";

  const financials = resolveOfficialSellerPromotionFinancials(
    row,
    prices.final_price_brl,
    prices.reference_price_brl,
    {
      sameListingOtherPromotionPrices: opts.sameListingOtherPromotionPrices,
      sameListingSiblingRows: opts.sameListingSiblingRows,
      structuralAnonymousPriceDenylist: opts.structuralAnonymousPriceDenylist,
      listingId: opts.listingId ?? null,
      listingContext: opts.listingContext ?? null,
    }
  );

  return {
    promotion_id: promotionId,
    promotion_type: promotionType,
    offer_id: offerId,
    promotion_name: promotionName,
    final_price_brl: prices.final_price_brl,
    reference_price_brl: prices.reference_price_brl,
    price_applied: prices.price_applied,
    status: statusPack.normalized_status,
    raw_status: statusPack.raw_status,
    ml_effective_state: statusPack.ml_effective_state,
    promotion_active: statusPack.promotion_active,
    starts_at: toIsoDateStringOrNull(
      row.start_date ?? row.start_time ?? row.date_from ?? row.starts_at
    ),
    ends_at: toIsoDateStringOrNull(
      row.finish_date ?? row.end_date ?? row.date_to ?? row.finish_time ?? row.ends_at ?? row.stop_time
    ),
    source,
    identity_key: buildOfficialSellerPromotionIdentityKey(row),
    financials,
    ml_api_raw_row: row,
  };
}

/**
 * @param {Record<string, unknown>[]} rawRows
 * @param {ReturnType<typeof normalizeOfficialSellerPromotionRow>[]} normalizedRows
 * @param {{ listingId?: string | null; droppedAsDuplicate?: number }} opts
 */
function buildMissingPromotionAuditPayload(rawRows, normalizedRows, opts = {}) {
  const list = Array.isArray(rawRows) ? rawRows : [];
  /** @type {Record<string, unknown>[]} */
  const apiNamedRows = [];
  /** @type {{ promotion_id: string | null; promotion_name: string | null; promotion_type: string | null; reason: string }[]} */
  const ignoredCandidates = [];

  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rowObj = /** @type {Record<string, unknown>} */ (row);
    if (isStructuralAnonymousPriceDiscountRow(rowObj)) {
      ignoredCandidates.push({
        promotion_id: rowObj.id != null ? String(rowObj.id) : null,
        promotion_name: rowObj.name != null ? String(rowObj.name) : "PRICE_DISCOUNT",
        promotion_type: rowObj.type != null ? String(rowObj.type) : "PRICE_DISCOUNT",
        reason: "structural_anonymous_price_discount_filtered",
      });
      continue;
    }
    if (isNamedOfficialSellerPromotionRow(rowObj)) {
      apiNamedRows.push(rowObj);
    }
  }

  const normalizedNames = normalizedRows.map((p) => String(p.promotion_name ?? "").trim().toLowerCase());
  const apiNames = apiNamedRows.map((r) => String(r.name ?? r.promotion_name ?? "").trim().toLowerCase());

  return {
    listing_id: opts.listingId ?? null,
    api_rows_total: list.length,
    api_named_promotion_count: apiNamedRows.length,
    normalized_promotion_count: normalizedRows.length,
    dropped_as_duplicate: opts.droppedAsDuplicate ?? 0,
    api_promotion_names: apiNamedRows.map((r) => String(r.name ?? r.promotion_name ?? "").trim()),
    normalized_promotion_names: normalizedRows.map((p) => p.promotion_name),
    missing_from_normalized: apiNames.filter((name) => name !== "" && !normalizedNames.includes(name)),
    ignored_candidates: ignoredCandidates,
    source_trace: ["normalizeOfficialSellerPromotionsFromApi"],
  };
}

/**
 * @param {string | null | undefined} listingId
 * @param {ReturnType<typeof buildListingVariationContextForPromotions>} listingContext
 * @param {Record<string, unknown>[]} rawRows
 * @param {{
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   sameListingSiblingRows?: Record<string, unknown>[];
 * }} [opts]
 */
function auditPromotionVariationContextPropagation(listingId, listingContext, rawRows, opts = {}) {
  if (listingContext?.has_listing_variations !== true) return;

  const rows = Array.isArray(rawRows) ? rawRows : [];
  const beforeCtx = {
    variations_count: 0,
    has_listing_variations: false,
    raw_json: null,
  };
  let promotionsAffected = 0;
  /** @type {string | null} */
  let beforeDiscountSource = null;
  /** @type {string | null} */
  let afterDiscountSource = null;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (isStructuralAnonymousPriceDiscountRow(row)) continue;
    const resolveOpts = {
      structuralAnonymousPriceDenylist: opts.structuralAnonymousPriceDenylist,
      sameListingSiblingRows: opts.sameListingSiblingRows ?? rows,
      listingId: listingId ?? null,
      skipLiquidaCaseAudit: true,
    };
    const before = resolvePromotionUiFinancials(row, {
      ...resolveOpts,
      listingContext: beforeCtx,
    });
    const after = resolvePromotionUiFinancials(row, {
      ...resolveOpts,
      listingContext,
    });
    if (before.discount_source !== after.discount_source) {
      promotionsAffected += 1;
      if (beforeDiscountSource == null) {
        beforeDiscountSource = before.discount_source ?? null;
        afterDiscountSource = after.discount_source ?? null;
      }
    }
  }

  logS7PromotionVariationContextPropagation({
    listing_id: listingId ?? null,
    raw_variations_length: listingContext.raw_variations_length ?? null,
    raw_variations_count_field: listingContext.raw_variations_count_field ?? null,
    resolved_variations_count: listingContext.variations_count ?? null,
    has_listing_variations: listingContext.has_listing_variations === true,
    listingContext_source: listingContext.listingContext_source ?? null,
    promotions_affected: promotionsAffected,
    before_discount_source: beforeDiscountSource,
    after_discount_source: afterDiscountSource,
  });
}

/**
 * Normaliza e deduplica linhas brutas do endpoint oficial (1 linha API → no máximo 1 candidato).
 * @param {Record<string, unknown>[]} rawRows
 * @param {{
 *   source?: "live" | "persisted";
 *   listingId?: string | null;
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   listingContext?: ReturnType<typeof buildListingVariationContextForPromotions>;
 * }} [opts]
 */
export function normalizeOfficialSellerPromotionsFromApi(rawRows, opts = {}) {
  /** @type {Map<string, ReturnType<typeof normalizeOfficialSellerPromotionRow>>} */
  const byIdentity = new Map();
  let droppedAsDuplicate = 0;
  const list = Array.isArray(rawRows) ? rawRows : [];
  /** @type {string[]} */
  const sameListingOtherPromotionPrices = [];
  const seenOtherPrices = new Set();

  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    if (isStructuralAnonymousPriceDiscountRow(/** @type {Record<string, unknown>} */ (row))) continue;
    if (isLiquidaFullOutletOfficialSellerPromotionRow(/** @type {Record<string, unknown>} */ (row))) continue;
    const prelimUi = resolvePromotionUiFinancials(/** @type {Record<string, unknown>} */ (row), {
      skipLiquidaCaseAudit: true,
      structuralAnonymousPriceDenylist: opts.structuralAnonymousPriceDenylist,
      listingId: opts.listingId ?? null,
      listingContext: opts.listingContext ?? null,
    });
    if (prelimUi.final_price_brl != null && !seenOtherPrices.has(prelimUi.final_price_brl)) {
      seenOtherPrices.add(prelimUi.final_price_brl);
      sameListingOtherPromotionPrices.push(prelimUi.final_price_brl);
    }
  }

  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    if (isStructuralAnonymousPriceDiscountRow(/** @type {Record<string, unknown>} */ (row))) {
      continue;
    }
    const rowObj = /** @type {Record<string, unknown>} */ (row);
    const normalized = normalizeOfficialSellerPromotionRow(rowObj, {
      ...opts,
      sameListingSiblingRows: list.filter((r) => r && typeof r === "object"),
      sameListingOtherPromotionPrices: isLiquidaFullOutletOfficialSellerPromotionRow(rowObj)
        ? sameListingOtherPromotionPrices
        : undefined,
    });
    const listKey = buildOfficialSellerPromotionListDedupeKey(
      /** @type {Record<string, unknown>} */ (row)
    );
    if (normalized.promotion_id === "" && listKey.replace(/\|/g, "") === "") continue;
    const dedupeKey =
      listKey.replace(/\|/g, "") !== "" ? listKey : normalized.identity_key;
    const prev = byIdentity.get(dedupeKey);
    if (prev != null) {
      droppedAsDuplicate += 1;
      if (normalized.source === "live" && prev.source !== "live") {
        byIdentity.set(dedupeKey, normalized);
      }
      continue;
    }
    byIdentity.set(dedupeKey, normalized);
  }

  const out = Array.from(byIdentity.values());
  const statusCounts = out.reduce(
    (acc, p) => {
      const k = p.raw_status != null ? String(p.raw_status) : "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    },
    /** @type {Record<string, number>} */ ({})
  );

  logS7PromotionMissingPromotionAudit(
    buildMissingPromotionAuditPayload(list, out, {
      listingId: opts.listingId ?? null,
      droppedAsDuplicate,
    })
  );

  if (opts.listingContext?.has_listing_variations === true) {
    auditPromotionVariationContextPropagation(opts.listingId ?? null, opts.listingContext, list, {
      structuralAnonymousPriceDenylist: opts.structuralAnonymousPriceDenylist,
      sameListingSiblingRows: list,
    });
  }

  return {
    promotions: out,
    normalized_total: out.length,
    dropped_as_duplicate: droppedAsDuplicate,
    status_counts: statusCounts,
    identity_keys: out.map((p) => p.identity_key),
  };
}

/**
 * Mescla linha enriquecida preservando identidade da linha base /seller-promotions/items.
 * @param {Record<string, unknown>} baseRow
 * @param {Record<string, unknown>} enrichedRow
 */
const CAMPOS_FINANCEIROS_ENRICHMENT = [
  "price",
  "amount",
  "deal_price",
  "promotion_price",
  "buyer_price",
  "fixed_price",
  "original_price",
  "total_price_for_boosted_offer",
  "boosted_offer",
  "suggested_discounted_price",
  "top_deal_price",
  "top_deal",
  "max_discounted_price",
  "min_discounted_price",
  "discount_amount",
  "total_discount_amount",
  "seller_discount_amount",
  "min_discount_amount",
  "max_discount_amount",
  "discount_percentage",
  "discount_percent",
  "seller_percentage",
  "meli_percentage",
  "discount_meli_boost_amount",
  "discount_meli_boosted_percentage",
  "meli_boost_amount",
  "amount_to_receive",
  "original_fee_amount",
  "gross_fee_amount",
  "final_fee_amount",
  "fee_amount",
  "fee_discount_amount",
  "marketplace_fee_discount_amount",
];

export function mergeEnrichedOfficialSellerPromotionRow(baseRow, enrichedRow, opts = {}) {
  const merged = { ...baseRow };
  const isNamed = isNamedOfficialSellerPromotionRow(baseRow);
  for (const key of CAMPOS_FINANCEIROS_ENRICHMENT) {
    if (enrichedRow[key] == null || String(enrichedRow[key]).trim() === "") continue;
    if (
      (key === "price" || key === "amount" || key === "deal_price") &&
      toDec(enrichedRow[key])?.lte(0) === true &&
      toDec(baseRow[key])?.gt(0) === true
    ) {
      continue;
    }
    if (
      key === "suggested_discounted_price" &&
      isNamed &&
      isStructuralAnonymousPriceDiscountRow(enrichedRow)
    ) {
      continue;
    }
    merged[key] = enrichedRow[key];
  }
  if (baseRow.id != null) merged.id = baseRow.id;
  if (baseRow.promotion_id != null) merged.promotion_id = baseRow.promotion_id;
  if (baseRow.type != null) merged.type = baseRow.type;
  if (baseRow.promotion_type != null) merged.promotion_type = baseRow.promotion_type;
  if (baseRow.ref_id != null) merged.ref_id = baseRow.ref_id;
  if (baseRow.offer_id != null) merged.offer_id = baseRow.offer_id;
  if (baseRow.name != null) merged.name = baseRow.name;
  if (baseRow.promotion_name != null) merged.promotion_name = baseRow.promotion_name;
  if (baseRow.status != null) merged.status = baseRow.status;
  // Preserva tier ML da listagem quando enrichment por item não traz suggested/max.
  if (
    (merged.suggested_discounted_price == null ||
      String(merged.suggested_discounted_price).trim() === "") &&
    baseRow.suggested_discounted_price != null &&
    String(baseRow.suggested_discounted_price).trim() !== ""
  ) {
    merged.suggested_discounted_price = baseRow.suggested_discounted_price;
  }
  if (
    (merged.max_discounted_price == null || String(merged.max_discounted_price).trim() === "") &&
    baseRow.max_discounted_price != null &&
    String(baseRow.max_discounted_price).trim() !== ""
  ) {
    merged.max_discounted_price = baseRow.max_discounted_price;
  }
  if (isLiquidaFullOutletOfficialSellerPromotionRow(baseRow)) {
    const baseMaxDec = toDec(baseRow.max_discounted_price);
    const mergedMaxDec = toDec(merged.max_discounted_price);
    if (
      baseMaxDec != null &&
      mergedMaxDec != null &&
      baseMaxDec.gt(mergedMaxDec)
    ) {
      merged.max_discounted_price = baseRow.max_discounted_price;
    }
  }
  const promoType = baseRow.type ?? baseRow.promotion_type ?? baseRow.sub_type;
  if (tipoIndicaRelampagoPromocao(promoType)) {
    if (baseRow.min_discounted_price != null && String(baseRow.min_discounted_price).trim() !== "") {
      merged._suse7_list_min_discounted_price = baseRow.min_discounted_price;
    }
    const topDealDec = toDec(merged.top_deal_price ?? merged.top_deal);
    const priceDec = toDec(merged.price ?? merged.amount ?? merged.deal_price);
    if (
      topDealDec != null &&
      topDealDec.gt(0) &&
      (priceDec == null || topDealDec.lt(priceDec))
    ) {
      merged.price = decStr2FromDec(topDealDec);
    }
  }
  merged._suse7_price_enriched = true;
  return merged;
}

/** @param {Decimal} d */
function decStr2FromDec(d) {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Candidate/disponível e LIGHTNING sempre passam pelo enrichment por item — price da listagem
 * /seller-promotions/items pode ser limite/sugestão errada (ex.: max_discounted_price ≈ 10%).
 *
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
export function promotionRowNeedsPriceEnrichment(row) {
  const statusNorm = rawPromotionStatusNormalized(row);
  const promoType = row.type ?? row.promotion_type;
  if (isCandidateLikePromotionStatus(statusNorm) || tipoIndicaRelampagoPromocao(promoType)) {
    return true;
  }

  const ui = resolvePromotionUiFinancials(row);
  if (ui.source_confidence !== "official_item_promotion_price") return true;

  const limitSources = new Set(["max_discounted_price", "min_discounted_price"]);
  if (limitSources.has(String(ui.final_price_source ?? ""))) return true;

  return false;
}

/**
 * Enriquece linhas incompletas via GET /seller-promotions/promotions/:id/items?item_id=...
 *
 * @param {string} accessToken
 * @param {string} itemId
 * @param {Record<string, unknown>[]} rawRows
 * @param {typeof import("../../handlers/ml/_helpers/mercadoLibreItemsApi.js").fetchSellerPromotionItemsForListing} fetchPromotionItems
 */
export async function enrichOfficialSellerPromotionRowsFromApi(
  accessToken,
  itemId,
  rawRows,
  fetchPromotionItems
) {
  const list = Array.isArray(rawRows) ? rawRows : [];
  const structuralAnonymousPriceDenylist = buildStructuralAnonymousPriceDenylist(list);
  /** @type {Record<string, unknown>[]} */
  const out = [];

  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    if (isStructuralAnonymousPriceDiscountRow(row)) {
      out.push(/** @type {Record<string, unknown>} */ ({ ...row }));
      continue;
    }
    let current = /** @type {Record<string, unknown>} */ ({ ...row });
    const before = resolvePromotionUiFinancials(current, { structuralAnonymousPriceDenylist });

    if (promotionRowNeedsPriceEnrichment(current)) {
      const pid = current.id ?? current.promotion_id;
      const ptype = current.type ?? current.promotion_type ?? current.sub_type;
      if (pid != null && ptype != null && accessToken && itemId) {
        try {
          const items = await fetchPromotionItems(
            accessToken,
            String(pid).trim(),
            String(ptype).trim(),
            String(itemId).trim()
          );
          const iid = String(itemId).trim();
          const match =
            items.find((it) => String(it.item_id ?? it.id ?? "").trim() === iid) ?? items[0] ?? null;
          if (match != null && typeof match === "object") {
            current = mergeEnrichedOfficialSellerPromotionRow(current, match, {
              structuralAnonymousPriceDenylist,
            });
            const after = resolvePromotionUiFinancials(current, { structuralAnonymousPriceDenylist });
            logS7PromotionsPiAudit("promotion_row_enriched", {
              listing_external_id: iid,
              promotion_id: pid,
              promotion_name: current.name ?? current.promotion_name ?? null,
              source_confidence_before: before.source_confidence,
              source_confidence_after: after.source_confidence,
              final_price_before: before.final_price_brl,
              final_price_after: after.final_price_brl,
              final_price_source_after: after.final_price_source,
            });
          }
        } catch (e) {
          logS7PromotionsPiAudit("promotion_row_enrich_failed", {
            listing_external_id: itemId,
            promotion_id: pid,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    out.push(current);
  }

  return out;
}

/**
 * Elegibilidade UI — somente status oficiais ML (started/pending/candidate) + desconhecido com log.
 * @param {{ raw_status?: string | null; ends_at?: string | null }} p
 */
export function evaluateOfficialPromotionUiEligibility(p) {
  const raw = p.raw_status != null ? String(p.raw_status).trim().toLowerCase() : "";
  if (raw === "finished" || raw === "expired" || raw === "cancelled" || raw === "inactive") {
    return { ok: false, reason: "expired" };
  }
  if (raw === "started" || raw === "pending" || raw === "candidate") {
    if (p.ends_at != null && String(p.ends_at).trim() !== "") {
      const tEnd = Date.parse(String(p.ends_at));
      if (Number.isFinite(tEnd) && tEnd < Date.now()) return { ok: false, reason: "expired" };
    }
    return { ok: true };
  }
  if (raw !== "" && raw !== "unknown") {
    logS7MlPromosAudit("status_unknown_included", raw);
  }
  return { ok: true };
}
