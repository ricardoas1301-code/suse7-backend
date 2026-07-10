// ======================================================
// Custos operacionais — Raio-x da venda (somente snapshot histórico).
// Sem fallback de configuração viva do listing/Precificação.
// ======================================================

import Decimal from "decimal.js";
import {
  fetchListingHealthCommercialFlagsDetailed,
  moneyFromPercentOfGross,
  resolveSaleCommercialLookup,
} from "./saleListingHealthCommercial.js";

const ROUND = Decimal.ROUND_HALF_UP;

/** @type {ReadonlyArray<{ key: string; label: string }>} */
export const SALE_RAYX_OPERATIONAL_COST_SPECS = [
  { key: "ml_ads", label: "ML Ads" },
  { key: "safety_reserve", label: "Custos Operacionais" },
];

/**
 * @param {unknown} raw
 * @returns {Decimal | null}
 */
function toDec(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().replace("%", "");
  if (!text) return null;
  try {
    const dec = new Decimal(text.replace(",", "."));
    return dec.isFinite() ? dec : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} v
 * @returns {Record<string, unknown> | null}
 */
function toObj(v) {
  return v && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : null;
}

/**
 * @param {unknown} raw
 */
function fieldWasPresent(raw) {
  return raw != null && String(raw).trim() !== "";
}

/**
 * @param {Record<string, unknown> | null | undefined} itemFin
 * @param {Record<string, unknown> | null | undefined} orderFin
 * @param {Record<string, unknown> | null | undefined} snap
 */
function readHistoricalOperationalFields(itemFin, orderFin, snap) {
  const adsSnap = toObj(itemFin?.ads_snapshot);
  const operationalSnap = toObj(itemFin?.operational_cost_snapshot);

  return {
    ml_ads: {
      amount:
        snap?.ml_ads_brl ??
        snap?.ml_ads_amount_brl ??
        adsSnap?.amount_brl ??
        adsSnap?.ml_ads_brl ??
        null,
      percent: snap?.ml_ads_percent ?? adsSnap?.percent ?? adsSnap?.ml_ads_percent ?? null,
    },
    safety_reserve: {
      amount:
        snap?.reserve_brl ??
        snap?.safety_reserve_brl ??
        snap?.reserve_amount_brl ??
        operationalSnap?.reserve_brl ??
        operationalSnap?.operational_costs_brl ??
        null,
      percent:
        snap?.reserve_percent ??
        snap?.safety_reserve_percent ??
        operationalSnap?.reserve_percent ??
        operationalSnap?.safety_reserve_percent ??
        null,
    },
  };
}

/**
 * @param {{ amount: unknown; percent: unknown }} fields
 * @param {unknown} grossMoney
 */
function resolveHistoricalLine(fields, grossMoney) {
  const hasAmount = fieldWasPresent(fields.amount);
  const hasPercent = fieldWasPresent(fields.percent);

  if (!hasAmount && !hasPercent) {
    return { present: false, amount_brl: "0.00", percent: "0.00" };
  }

  let amountStr = hasAmount ? String(fields.amount).trim() : null;
  const percentStr = hasPercent ? String(fields.percent).trim() : null;

  if (amountStr == null && percentStr != null && grossMoney != null) {
    const derived = moneyFromPercentOfGross(grossMoney, percentStr);
    if (derived != null) amountStr = derived;
  }

  const amountDec = amountStr != null ? toDec(amountStr) : null;
  const percentDec = percentStr != null ? toDec(percentStr) : null;

  return {
    present: true,
    amount_brl: amountDec != null ? amountDec.toDecimalPlaces(2, ROUND).toFixed(2) : "0.00",
    percent: percentDec != null ? percentDec.toDecimalPlaces(2, ROUND).toFixed(2) : "0.00",
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {unknown} [grossMoneyHint]
 */
export function resolveSaleRayxOperationalCostsFromSnapshot(item, order, grossMoneyHint = null) {
  const itemRaw = toObj(item?.raw_json);
  const itemFin = toObj(itemRaw?._s7_financial);
  const orderRaw = toObj(order?.raw_json);
  const orderFin = toObj(orderRaw?._s7_financial);

  const snap =
    toObj(itemFin?.contingency_margin_snapshot) ?? toObj(orderFin?.contingency_margin_snapshot);

  const grossMoney =
    grossMoneyHint ??
    snap?.gross_sale_amount_brl ??
    itemFin?.gross_sale_amount_brl ??
    itemFin?.gross_amount_brl ??
    item?.gross_amount ??
    item?.net_amount ??
    null;

  const fields = readHistoricalOperationalFields(itemFin, orderFin, snap);
  const mlAds = resolveHistoricalLine(fields.ml_ads, grossMoney);
  const reserve = resolveHistoricalLine(fields.safety_reserve, grossMoney);

  const hasHistorical = mlAds.present || reserve.present || Boolean(snap);
  /** @type {Array<Record<string, unknown>>} */
  const lines = SALE_RAYX_OPERATIONAL_COST_SPECS.map((spec) => {
    const resolved = spec.key === "ml_ads" ? mlAds : reserve;
    return {
      key: spec.key,
      label: spec.label,
      amount_brl: resolved.amount_brl,
      percent: resolved.percent,
    };
  });

  return {
    lines,
    source: hasHistorical ? "snapshot" : "zero_fallback",
    hasHistorical,
  };
}

/**
 * @param {Array<Record<string, unknown>>} lines
 */
export function pickNonZeroOperationalCostLinesForContingency(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.filter((row) => {
    const amount = toDec(row.amount_brl);
    return amount != null && amount.gt(0);
  });
}

/**
 * @param {{
 *   item: Record<string, unknown>;
 *   order: Record<string, unknown> | null | undefined;
 *   financial: Record<string, unknown>;
 *   saleId?: string | null;
 *   orderId?: string | null;
 *   listingId?: string | null;
 *   saleDate?: string | null;
 * }} ctx
 */
export function buildSaleRayxOperationalCostsDisplayBlock(ctx) {
  const grossMoney =
    ctx.financial?.marketplace_revenue &&
    typeof ctx.financial.marketplace_revenue === "object" &&
    /** @type {Record<string, unknown>} */ (ctx.financial.marketplace_revenue).gross_sale_amount_brl != null
      ? /** @type {Record<string, unknown>} */ (ctx.financial.marketplace_revenue).gross_sale_amount_brl
      : ctx.financial?.gross_amount ?? ctx.financial?.sale_price ?? null;

  const resolved = resolveSaleRayxOperationalCostsFromSnapshot(ctx.item, ctx.order, grossMoney);
  const mlAds = resolved.lines.find((line) => line.key === "ml_ads") ?? null;
  const reserve = resolved.lines.find((line) => line.key === "safety_reserve") ?? null;

  if (process.env.S7_SALE_RAYX_OPERATIONAL_COSTS_DEBUG === "1") {
    console.log("[S7_SALE_RAYX_OPERATIONAL_COSTS_SOURCE]", {
      sale_id: ctx.saleId ?? null,
      order_id: ctx.orderId ?? null,
      listing_id: ctx.listingId ?? null,
      sale_date: ctx.saleDate ?? null,
      source: resolved.source,
      ml_ads_percent: mlAds?.percent ?? "0.00",
      ml_ads_amount: mlAds?.amount_brl ?? "0.00",
      operational_cost_percent: reserve?.percent ?? "0.00",
      operational_cost_amount: reserve?.amount_brl ?? "0.00",
    });
  }

  return {
    lines: resolved.lines,
    source: resolved.source,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} existingFinancial
 */
export function shouldCaptureOperationalCostsSnapshotOnPersist(existingFinancial) {
  if (!existingFinancial || typeof existingFinancial !== "object") return true;
  if (toObj(existingFinancial.contingency_margin_snapshot)) return false;
  const immutableSince =
    existingFinancial.immutable_since != null ? String(existingFinancial.immutable_since).trim() : "";
  if (immutableSince) return false;
  const snapshotOrigin =
    existingFinancial.snapshot_origin != null ? String(existingFinancial.snapshot_origin).trim() : "";
  if (snapshotOrigin === "onboarding_import") return false;
  const snapshotCreatedAt =
    existingFinancial.snapshot_created_at != null ? String(existingFinancial.snapshot_created_at).trim() : "";
  if (snapshotCreatedAt) return false;
  return true;
}

/**
 * @param {import("./saleListingHealthCommercial.js").PricingSimulationConfig} flags
 * @param {unknown} grossMoney
 */
export function buildOperationalCostsSnapshotAtSaleCapture(flags, grossMoney) {
  /** @param {"ml_ads" | "safety_reserve"} key */
  const readFlag = (key) => {
    const node = flags?.[key];
    const enabled =
      node &&
      typeof node === "object" &&
      (/** @type {Record<string, unknown>} */ (node).enabled === true ||
        String(/** @type {Record<string, unknown>} */ (node).enabled ?? "").toLowerCase() === "true");
    const percentRaw =
      node && typeof node === "object" ? /** @type {Record<string, unknown>} */ (node).percent : null;
    const pctDec = enabled && fieldWasPresent(percentRaw) ? toDec(percentRaw) : new Decimal(0);
    const pctStr = pctDec.toDecimalPlaces(2, ROUND).toFixed(2);
    const amountStr =
      pctDec.gt(0) && grossMoney != null
        ? moneyFromPercentOfGross(grossMoney, pctStr) ?? "0.00"
        : "0.00";
    return { percent: pctStr, amount_brl: amountStr };
  };

  const mlAds = readFlag("ml_ads");
  const reserve = readFlag("safety_reserve");
  const capturedAt = new Date().toISOString();

  return {
    contingency_margin_snapshot: {
      ml_ads_brl: mlAds.amount_brl,
      ml_ads_percent: mlAds.percent,
      reserve_brl: reserve.amount_brl,
      reserve_percent: reserve.percent,
      safety_reserve_brl: reserve.amount_brl,
      safety_reserve_percent: reserve.percent,
      captured_at: capturedAt,
      source: "listing_config_at_sale_capture",
    },
    ads_snapshot: {
      amount_brl: mlAds.amount_brl,
      percent: mlAds.percent,
      ml_ads_brl: mlAds.amount_brl,
      ml_ads_percent: mlAds.percent,
      source: "listing_config_at_sale_capture",
      captured_at: capturedAt,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} itemRow
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} linkedListing
 * @param {unknown} grossMoney
 * @param {Record<string, unknown> | null | undefined} existingFinancial
 */
export async function captureOperationalCostsSnapshotForPersist(
  supabase,
  userId,
  itemRow,
  order,
  linkedListing,
  grossMoney,
  existingFinancial,
) {
  if (!shouldCaptureOperationalCostsSnapshotOnPersist(existingFinancial)) {
    return null;
  }

  const lookup = resolveSaleCommercialLookup(itemRow, order, {
    listingIdDisplay: null,
    listingExternalId:
      linkedListing?.external_listing_id != null
        ? String(linkedListing.external_listing_id)
        : itemRow.external_listing_id != null
          ? String(itemRow.external_listing_id)
          : null,
    listingMarketplace:
      linkedListing?.marketplace != null
        ? String(linkedListing.marketplace)
        : itemRow.marketplace != null
          ? String(itemRow.marketplace)
          : null,
  });

  if (!lookup.externalListingId) {
    return buildOperationalCostsSnapshotAtSaleCapture({}, grossMoney);
  }

  const { flags } = await fetchListingHealthCommercialFlagsDetailed(supabase, userId, lookup);
  return buildOperationalCostsSnapshotAtSaleCapture(flags, grossMoney);
}
