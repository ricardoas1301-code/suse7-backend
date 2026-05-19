import Decimal from "decimal.js";
import {
  coalesceMercadoLibreItemForMoneyExtract,
  extractSaleFee,
  toFiniteNumber,
} from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import { formatMercadoLivreListingTypeLabel, mercadoLivreFeeFromPercentOfGross } from "./mercadoLivreSaleRevenueRules.js";

/** @param {unknown} v */
function parseMlMoney(v) {
  return toFiniteNumber(v);
}

/** @param {Decimal | null} d */
function moneyDecimal(d) {
  if (!d) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * @param {string | null | undefined} listingTypeId
 */
export function normalizeMercadoLivreListingType(listingTypeId) {
  const id = String(listingTypeId ?? "")
    .trim()
    .toLowerCase();
  if (id.includes("gold_pro") || id.includes("gold_premium")) {
    return { listing_type: "premium", listing_type_label: "Premium", default_percent: "16.5" };
  }
  if (id.includes("gold_special")) {
    return { listing_type: "classic", listing_type_label: "Clássico", default_percent: "11.5" };
  }
  if (id.includes("gold")) {
    return { listing_type: "gold", listing_type_label: "Ouro", default_percent: null };
  }
  if (id.includes("free")) {
    return { listing_type: "free", listing_type_label: "Grátis", default_percent: null };
  }
  return { listing_type: null, listing_type_label: null, default_percent: null };
}

/**
 * @param {unknown} percent
 */
function normalizePercentString(percent) {
  if (percent == null) return null;
  const n = parseMlMoney(percent);
  if (n == null || n <= 0 || n > 40) return null;
  return new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * @param {{
 *   marketplace?: string | null;
 *   listing_type_id?: string | null;
 *   listing_type?: string | null;
 *   raw_json?: Record<string, unknown> | null;
 *   item_raw_json?: Record<string, unknown> | null;
 *   order_raw_json?: Record<string, unknown> | null;
 *   existing_financial_data?: Record<string, unknown> | null;
 *   listing?: Record<string, unknown> | null;
 * }} ctx
 */
export function resolveMercadoLivreSaleFeeRate(ctx = {}) {
  const existing = ctx.existing_financial_data;

  const line =
    ctx.item_raw_json && typeof ctx.item_raw_json === "object"
      ? ctx.item_raw_json
      : ctx.raw_json && typeof ctx.raw_json === "object"
        ? ctx.raw_json
        : null;

  if (line?.sale_fee_details) {
    const fromDetails = extractSaleFee(coalesceMercadoLibreItemForMoneyExtract(line), {
      deriveFromPercent: true,
      skipDeepExtract: true,
    });
    const pct = normalizePercentString(fromDetails.percent);
    if (pct) {
      const listingTypeId = ctx.listing_type_id ?? line.listing_type_id ?? null;
      const norm = normalizeMercadoLivreListingType(listingTypeId);
      return {
        percentage: pct,
        listing_type: norm.listing_type,
        listing_type_label: norm.listing_type_label,
        source: "line.sale_fee_details_percent",
        is_estimated: false,
      };
    }
  }

  if (line && typeof line === "object") {
    for (const key of ["sale_fee_percent", "marketplace_fee_percent", "fee_percent"]) {
      const pct = normalizePercentString(line[key]);
      if (pct) {
        const listingTypeId = ctx.listing_type_id ?? line.listing_type_id ?? null;
        const norm = normalizeMercadoLivreListingType(listingTypeId);
        return {
          percentage: pct,
          listing_type: norm.listing_type,
          listing_type_label: norm.listing_type_label,
          source: `line.${key}`,
          is_estimated: false,
        };
      }
    }
  }

  const listing = ctx.listing;
  const listingRaw =
    listing?.raw_json && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;
  if (listingRaw) {
    for (const key of ["sale_fee_percent", "marketplace_fee_percent", "fee_percent"]) {
      const pct = normalizePercentString(listingRaw[key]);
      if (pct) {
        const listingTypeId = ctx.listing_type_id ?? listing.listing_type_id ?? null;
        const norm = normalizeMercadoLivreListingType(listingTypeId);
        return {
          percentage: pct,
          listing_type: norm.listing_type,
          listing_type_label: norm.listing_type_label,
          source: `listing.${key}`,
          is_estimated: false,
        };
      }
    }
    const health =
      listingRaw.marketplace_listing_health && typeof listingRaw.marketplace_listing_health === "object"
        ? /** @type {Record<string, unknown>} */ (listingRaw.marketplace_listing_health)
        : listingRaw._s7_listing_health && typeof listingRaw._s7_listing_health === "object"
          ? /** @type {Record<string, unknown>} */ (listingRaw._s7_listing_health)
          : null;
    if (health?.sale_fee_percent != null) {
      const pct = normalizePercentString(health.sale_fee_percent);
      if (pct) {
        const listingTypeId = ctx.listing_type_id ?? listing.listing_type_id ?? null;
        const norm = normalizeMercadoLivreListingType(listingTypeId);
        return {
          percentage: pct,
          listing_type: norm.listing_type,
          listing_type_label: norm.listing_type_label,
          source: "listing.health.sale_fee_percent",
          is_estimated: false,
        };
      }
    }
  }

  const existingFee =
    existing?.marketplace_fee && typeof existing.marketplace_fee === "object"
      ? /** @type {Record<string, unknown>} */ (existing.marketplace_fee)
      : null;
  if (existingFee?.percentage != null) {
    const pct = normalizePercentString(existingFee.percentage);
    if (pct) {
      return {
        percentage: pct,
        listing_type: existingFee.listing_type != null ? String(existingFee.listing_type) : null,
        listing_type_label:
          existingFee.listing_type_label != null ? String(existingFee.listing_type_label) : null,
        source: "existing_financial_data.marketplace_fee",
        is_estimated: existingFee.is_estimated === true,
      };
    }
  }

  if (existing?.marketplace_fee_percent != null) {
    const pct = normalizePercentString(existing.marketplace_fee_percent);
    if (pct) {
      const listingTypeId = ctx.listing_type_id ?? null;
      const norm = normalizeMercadoLivreListingType(listingTypeId);
      return {
        percentage: pct,
        listing_type: norm.listing_type,
        listing_type_label: norm.listing_type_label,
        source: "existing_financial_data.marketplace_fee_percent",
        is_estimated: false,
      };
    }
  }

  const listingTypeId = ctx.listing_type_id ?? line?.listing_type_id ?? listing?.listing_type_id ?? null;
  const norm = normalizeMercadoLivreListingType(listingTypeId);
  if (norm.default_percent) {
    return {
      percentage: norm.default_percent,
      listing_type: norm.listing_type,
      listing_type_label: norm.listing_type_label,
      source: `listing_type_default_${norm.listing_type}`,
      is_estimated: true,
    };
  }

  return {
    percentage: null,
    listing_type: norm.listing_type,
    listing_type_label: norm.listing_type_label ?? formatMercadoLivreListingTypeLabel(listingTypeId),
    source: null,
    is_estimated: true,
  };
}

/**
 * @param {{
 *   sale_price_brl: string | number | Decimal;
 *   fee_percentage: string | number | Decimal;
 *   qty?: number;
 *   unit_price_brl?: string | number | Decimal | null;
 * }} input
 */
export function calculateMarketplaceFeeAmount(input) {
  const pct = normalizePercentString(input.fee_percentage);
  if (!pct) return null;

  const qty = input.qty != null && input.qty > 1 ? Math.trunc(input.qty) : 1;
  const unitRaw = input.unit_price_brl;
  const unitDec = unitRaw != null ? new Decimal(parseMlMoney(unitRaw) ?? 0) : null;
  const grossDec = new Decimal(parseMlMoney(input.sale_price_brl) ?? 0);
  if (grossDec.lte(0)) return null;

  const fromGross = mercadoLivreFeeFromPercentOfGross(grossDec, pct, {
    qty,
    unitPriceDec: unitDec != null && unitDec.gt(0) ? unitDec : null,
  });
  return fromGross != null ? moneyDecimal(fromGross) : null;
}

/**
 * @param {{
 *   sale_price_brl: string | null;
 *   listing_type_id?: string | null;
 *   line?: Record<string, unknown> | null;
 *   listing?: Record<string, unknown> | null;
 *   existing_financial_data?: Record<string, unknown> | null;
 *   qty?: number;
 *   unit_price_brl?: string | null;
 * }} ctx
 */
export function buildMercadoLivreMarketplaceFeeContract(ctx) {
  const salePrice = ctx.sale_price_brl != null ? String(ctx.sale_price_brl).trim() : "";
  const listingTypeId = ctx.listing_type_id ?? null;
  const rate = resolveMercadoLivreSaleFeeRate({
    listing_type_id: listingTypeId,
    item_raw_json: ctx.line ?? null,
    listing: ctx.listing ?? null,
    existing_financial_data: ctx.existing_financial_data ?? null,
  });

  const amountBrl =
    salePrice !== "" && rate.percentage
      ? calculateMarketplaceFeeAmount({
          sale_price_brl: salePrice,
          fee_percentage: rate.percentage,
          qty: ctx.qty ?? 1,
          unit_price_brl: ctx.unit_price_brl ?? null,
        })
      : null;

  const nowIso = new Date().toISOString();

  return {
    source: "mercado_livre",
    listing_type: rate.listing_type,
    listing_type_label: rate.listing_type_label,
    percentage: rate.percentage,
    amount_brl: amountBrl,
    calculation_base_brl: salePrice !== "" ? salePrice : null,
    calculation_method: "sale_price_times_percentage",
    is_estimated: rate.is_estimated,
    percent_source: rate.source,
    updated_at: nowIso,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} fin
 */
export function marketplaceFeeFromFinancialSnapshot(fin) {
  if (!fin || typeof fin !== "object") return null;
  const nested =
    fin.marketplace_fee && typeof fin.marketplace_fee === "object"
      ? /** @type {Record<string, unknown>} */ (fin.marketplace_fee)
      : null;
  if (nested?.amount_brl) return nested;
  if (fin.marketplace_fee_amount_brl && fin.marketplace_fee_percent) {
    return {
      source: "mercado_livre",
      listing_type: normalizeMercadoLivreListingType(fin.listing_type_id).listing_type,
      listing_type_label: fin.listing_type_label ?? formatMercadoLivreListingTypeLabel(fin.listing_type_id),
      percentage: String(fin.marketplace_fee_percent),
      amount_brl: String(fin.marketplace_fee_amount_brl),
      calculation_base_brl: fin.gross_sale_amount_brl != null ? String(fin.gross_sale_amount_brl) : null,
      calculation_method: "sale_price_times_percentage",
      is_estimated: false,
      percent_source: "legacy_flat_fields",
      updated_at: fin.updated_at != null ? String(fin.updated_at) : new Date().toISOString(),
    };
  }
  return null;
}
