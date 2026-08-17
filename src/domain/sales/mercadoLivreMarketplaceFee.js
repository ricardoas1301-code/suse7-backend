import Decimal from "decimal.js";
import {
  coalesceMercadoLibreItemForMoneyExtract,
  extractSaleFee,
  toFiniteNumber,
} from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import { extractMarketplaceFeeFromOrderPayments } from "../../services/marketplace/mercadoLivreSaleFinancialEnrichment.js";
import {
  applyMercadoLivreFeeGrossNetSplit,
  preferSaleFeeTimesQtyOverCatalogPromo,
  resolveMercadoLivreDiscountsFinancials,
  resolveMercadoLivreSaleFeeGross,
} from "./mercadoLivreSaleFinancialFormula.js";
import { formatMercadoLivreListingTypeLabel, mercadoLivreFeeFromPercentOfGross } from "./mercadoLivreSaleRevenueRules.js";

/** Tarifas de catálogo ML mais comuns — só para casar venda promocional (gross_price > unit_price). */
const ML_CATALOG_FEE_RATES = ["11.5", "13.5", "16.5"];

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

/** @param {unknown} percent */
function normalizePercentString(percent) {
  if (percent == null) return null;
  const n = parseMlMoney(percent);
  if (n == null || n <= 0 || n > 40) return null;
  const dec = new Decimal(n);
  const one = dec.toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
  if (dec.minus(one).abs().lte(new Decimal("0.04"))) {
    return one.toFixed(1);
  }
  return dec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Percentual efetivo a partir da tarifa real cobrada (fallback secundário).
 *
 * @param {{ fee_amount_brl: string | number | Decimal; sale_price_brl: string | number | Decimal }} input
 */
export function calculateEffectiveMarketplaceFeePercentage(input) {
  const feeDec = new Decimal(parseMlMoney(input.fee_amount_brl) ?? 0);
  const saleDec = new Decimal(parseMlMoney(input.sale_price_brl) ?? 0);
  if (feeDec.lte(0) || saleDec.lte(0)) return null;
  return feeDec.div(saleDec).mul(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
}

/**
 * @param {unknown} d
 */
function normalizeSaleFeeDetailsShape(d) {
  if (d == null) return { percent: null, amount: null };
  if (typeof d === "string") {
    const t = d.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return normalizeSaleFeeDetailsShape(JSON.parse(t));
      } catch {
        return { percent: null, amount: null };
      }
    }
    return { percent: null, amount: null };
  }
  if (typeof d !== "object") return { percent: null, amount: null };
  const rec = /** @type {Record<string, unknown>} */ (d);
  const percent = parseMlMoney(
    rec.percentage_fee ?? rec.meli_percentage_fee ?? rec.percentage ?? rec.percent,
  );
  const amount = parseMlMoney(
    rec.sale_fee ??
      rec.sale_fee_amount ??
      rec.selling_fee ??
      rec.gross_amount ??
      rec.total_amount ??
      rec.marketplace_fee,
  );
  return { percent, amount: amount != null && amount > 0 ? amount : null };
}

/**
 * Percentual explícito da venda (nunca catálogo/listing health).
 *
 * @param {Record<string, unknown> | null} line
 * @param {Record<string, unknown> | null} order
 */
function resolveExplicitSaleFeePercentage(line, order) {
  if (line?.sale_fee_details) {
    const fromDetails = normalizeSaleFeeDetailsShape(line.sale_fee_details);
    const pct = normalizePercentString(fromDetails.percent);
    if (pct) {
      return { percentage: pct, raw_percentage_source_path: "line.sale_fee_details.percentage_fee" };
    }
    const fromExtract = extractSaleFee(coalesceMercadoLibreItemForMoneyExtract(line), {
      deriveFromPercent: false,
      skipDeepExtract: true,
    });
    const pct2 = normalizePercentString(fromExtract.percent);
    if (pct2) {
      return { percentage: pct2, raw_percentage_source_path: "line.sale_fee_details(extract)" };
    }
  }

  if (line && typeof line === "object") {
    for (const key of ["sale_fee_percent", "marketplace_fee_percent", "fee_percent", "meli_percentage_fee"]) {
      const pct = normalizePercentString(line[key]);
      if (pct) {
        return { percentage: pct, raw_percentage_source_path: `line.${key}` };
      }
    }
  }

  const payments = order?.payments;
  if (Array.isArray(payments)) {
    for (let i = 0; i < payments.length; i += 1) {
      const pay = payments[i];
      if (!pay || typeof pay !== "object") continue;
      const p = /** @type {Record<string, unknown>} */ (pay);
      const feeDetails =
        p.fee_details && typeof p.fee_details === "object"
          ? /** @type {Record<string, unknown>} */ (p.fee_details)
          : null;
      for (const key of ["sale_fee_percent", "marketplace_fee_percent", "fee_percent", "percentage_fee"]) {
        const pct = normalizePercentString(feeDetails?.[key] ?? p[key]);
        if (pct) {
          return {
            percentage: pct,
            raw_percentage_source_path:
              feeDetails?.[key] != null ? `payments[${i}].fee_details.${key}` : `payments[${i}].${key}`,
          };
        }
      }
    }
  }

  return { percentage: null, raw_percentage_source_path: null };
}

/**
 * Vendas com preço promocional: ML exibe tarifa = taxa de catálogo × preço da venda,
 * enquanto `line.sale_fee` pode ser a parcela líquida retida na API.
 *
 * @param {{
 *   line?: Record<string, unknown> | null;
 *   sale_price_brl: string;
 *   sale_fee_subsidy_brl?: string | null;
 * }} ctx
 */
function tryCatalogRateForPromotionalSale(ctx) {
  const line = ctx.line;
  if (!line || typeof line !== "object") return null;

  const qty = Math.max(1, Math.trunc(parseMlMoney(line.quantity) ?? 1));
  const unit = parseMlMoney(line.unit_price ?? line.discounted_unit_price);
  const grossPrice = parseMlMoney(line.gross_price);
  const lineFee = parseMlMoney(line.sale_fee ?? line.listing_fee);
  const salePrice = parseMlMoney(ctx.sale_price_brl);
  if (unit == null || unit <= 0 || lineFee == null || lineFee <= 0) return null;

  const listingTypeId = line.listing_type_id != null ? String(line.listing_type_id) : null;
  if (
    qty > 1 &&
    preferSaleFeeTimesQtyOverCatalogPromo(line, qty, ctx.sale_price_brl, listingTypeId)
  ) {
    return null;
  }

  if (grossPrice == null || grossPrice <= unit * 1.01) return null;

  const norm = normalizeMercadoLivreListingType(listingTypeId);
  const ratesOrdered =
    norm.listing_type === "premium"
      ? ["13.5", "16.5", "11.5"]
      : norm.listing_type === "classic"
        ? ["11.5", "13.5", "16.5"]
        : [...ML_CATALOG_FEE_RATES];

  const unitDec = new Decimal(unit);
  const lineFeeDec = new Decimal(lineFee);
  const lineFeeTotalDec = qty > 1 ? lineFeeDec.mul(qty) : lineFeeDec;
  const salePriceDec = salePrice != null && salePrice > 0 ? new Decimal(salePrice) : null;
  const exactMatchTolerance = new Decimal("0.02");

  if (salePriceDec != null && qty > 1) {
    for (const rate of ratesOrdered) {
      const nominalOnSale = mercadoLivreFeeFromPercentOfGross(salePriceDec, rate, {
        qty,
        unitPriceDec: unitDec,
      });
      if (nominalOnSale == null) continue;
      if (nominalOnSale.minus(lineFeeTotalDec).abs().lte(exactMatchTolerance)) {
        return {
          amount_brl: moneyDecimal(nominalOnSale),
          percentage: rate,
          raw_amount_source_path: "line.sale_fee_x_qty_catalog_rate_on_sale",
          raw_percentage_source_path: `catalog_rate_${rate}`,
        };
      }
    }
  }

  for (const rate of ratesOrdered) {
    const nominal = mercadoLivreFeeFromPercentOfGross(unitDec, rate);
    if (nominal == null) continue;
    if (nominal.minus(lineFeeDec).abs().lte(exactMatchTolerance)) {
      return {
        amount_brl: moneyDecimal(lineFeeDec),
        percentage: rate,
        raw_amount_source_path: "line.sale_fee_promo_catalog_rate",
        raw_percentage_source_path: `catalog_rate_${rate}`,
      };
    }
  }

  /** @type {Array<{ rate: string; nominal: Decimal; netShare: Decimal; rebate: Decimal }>} */
  const candidates = [];
  const feeForPool = qty > 1 ? lineFeeTotalDec : lineFeeDec;

  if (salePriceDec != null && qty > 1) {
    for (const rate of ratesOrdered) {
      const nominal = mercadoLivreFeeFromPercentOfGross(salePriceDec, rate, {
        qty,
        unitPriceDec: unitDec,
      });
      if (nominal == null || nominal.lte(feeForPool)) continue;

      const netShare = feeForPool.div(nominal);
      if (netShare.lt(0.35) || netShare.gt(1.01)) continue;

      candidates.push({
        rate,
        nominal,
        netShare,
        rebate: nominal.minus(feeForPool),
      });
    }
  }

  for (const rate of ratesOrdered) {
    const nominal = mercadoLivreFeeFromPercentOfGross(unitDec, rate);
    if (nominal == null || nominal.lte(feeForPool)) continue;

    const netShare = feeForPool.div(nominal);
    if (netShare.lt(0.35) || netShare.gt(1.01)) continue;

    candidates.push({
      rate,
      nominal,
      netShare,
      rebate: nominal.minus(feeForPool),
    });
  }

  if (candidates.length === 0) return null;

  const minRebate = new Decimal("0.50");
  const promoWithRebate = candidates.filter((c) => c.rebate.gte(minRebate) && c.netShare.lt(0.98));
  const pool = promoWithRebate.length > 0 ? promoWithRebate : candidates;

  if (pool.length > 0) {
    /** @type {{ rate: string; nominal: Decimal; netShare: Decimal; rebate: Decimal } | undefined} */
    let hit;
    if (qty > 1 && salePriceDec != null) {
      hit = pool.reduce((best, c) => (!best || c.nominal.gt(best.nominal) ? c : best));
    } else {
      for (const rate of ratesOrdered) {
        hit = pool.find((c) => c.rate === rate);
        if (hit) break;
      }
      if (!hit) hit = pool[0];
    }
    return {
      amount_brl: moneyDecimal(hit.nominal),
      percentage: hit.rate,
      raw_amount_source_path: "derived:catalog_rate_times_sale_price_promo",
      raw_percentage_source_path: `catalog_rate_${hit.rate}`,
    };
  }

  return null;
}

/**
 * Tarifa bruta histórica da venda (payments, line, subsídio ML).
 *
 * @param {{
 *   line?: Record<string, unknown> | null;
 *   order?: Record<string, unknown> | null;
 *   item?: Record<string, unknown> | null;
 *   listing_type_id?: string | null;
 *   sale_price_brl?: string | null;
 *   qty?: number;
 *   unit_price_brl?: string | null;
 *   discounts_snapshot?: unknown;
 *   external_order_item_id?: string | null;
 * }} ctx
 */
function resolveHistoricalSaleFeeGross(ctx) {
  const line = ctx.line && typeof ctx.line === "object" ? ctx.line : null;
  const order = ctx.order && typeof ctx.order === "object" ? ctx.order : null;
  const salePrice = ctx.sale_price_brl != null ? parseMlMoney(ctx.sale_price_brl) : null;
  if (!line || salePrice == null || salePrice <= 0) {
    return { amount_brl: null, raw_amount_source_path: null };
  }

  const qty = ctx.qty != null && ctx.qty > 1 ? Math.trunc(ctx.qty) : 1;
  const unit = ctx.unit_price_brl != null ? parseMlMoney(ctx.unit_price_brl) : parseMlMoney(line.unit_price);
  const grossDec = new Decimal(salePrice);
  const listingTypeId = ctx.listing_type_id ?? line.listing_type_id ?? null;

  const orderLineCount = Array.isArray(order?.order_items) ? order.order_items.length : 1;
  const discountFin = resolveMercadoLivreDiscountsFinancials(
    ctx.discounts_snapshot,
    ctx.external_order_item_id ?? null,
    line,
    orderLineCount,
  );
  const saleFeeSubsidyDec =
    discountFin.sale_fee_subsidy_brl != null ? new Decimal(discountFin.sale_fee_subsidy_brl) : null;

  const feeResolved = resolveMercadoLivreSaleFeeGross(
    order ?? {},
    line,
    grossDec,
    qty,
    unit,
    listingTypeId,
    saleFeeSubsidyDec,
  );

  let feeGrossDec = feeResolved.fee;
  let rawPath = feeResolved.source;

  if (feeGrossDec != null) {
    const split = applyMercadoLivreFeeGrossNetSplit({
      feeGrossDec,
      feeNetDec: feeGrossDec,
      positiveDec:
        discountFin.positive_adjustments_brl != null
          ? new Decimal(discountFin.positive_adjustments_brl)
          : null,
      grossDec,
      listingTypeId,
      line,
      qty,
      unit,
    });
    feeGrossDec = split.feeGrossDec;
    if (split.positiveSource === "discounts_sale_fee_subsidy") {
      rawPath = "line.sale_fee_plus_sale_fee_subsidy";
    }
  }

  if (feeGrossDec != null) {
    return { amount_brl: moneyDecimal(feeGrossDec), raw_amount_source_path: rawPath };
  }

  if (line) {
    const rawLineFee = parseMlMoney(line.sale_fee ?? line.listing_fee);
    if (rawLineFee != null && rawLineFee > 0) {
      const feeDec = qty > 1 ? new Decimal(rawLineFee).mul(qty) : new Decimal(rawLineFee);
      return {
        amount_brl: moneyDecimal(feeDec),
        raw_amount_source_path: qty > 1 ? "line.sale_fee_x_qty" : "line.sale_fee",
      };
    }
  }

  const item = ctx.item;
  if (item?.fee_amount != null) {
    const amt = parseMlMoney(item.fee_amount);
    if (amt != null && amt > 0) {
      return {
        amount_brl: moneyDecimal(new Decimal(amt)),
        raw_amount_source_path: "sales_order_items.fee_amount",
      };
    }
  }

  return { amount_brl: null, raw_amount_source_path: null };
}

/**
 * @param {{
 *   sale_price_brl: string | null;
 *   listing_type_id?: string | null;
 *   line?: Record<string, unknown> | null;
 *   order?: Record<string, unknown> | null;
 *   item?: Record<string, unknown> | null;
 *   listing?: Record<string, unknown> | null;
 *   qty?: number;
 *   unit_price_brl?: string | null;
 *   discounts_snapshot?: unknown;
 *   external_order_item_id?: string | null;
 * }} ctx
 */
export function buildMercadoLivreMarketplaceFeeContract(ctx) {
  const salePrice = ctx.sale_price_brl != null ? String(ctx.sale_price_brl).trim() : "";
  const listingTypeId =
    ctx.listing_type_id ?? ctx.line?.listing_type_id ?? ctx.listing?.listing_type_id ?? null;
  const norm = normalizeMercadoLivreListingType(listingTypeId);
  const listingTypeLabel = norm.listing_type_label ?? formatMercadoLivreListingTypeLabel(listingTypeId);

  const orderRaw =
    ctx.order?.raw_json && typeof ctx.order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.order.raw_json)
      : ctx.order && typeof ctx.order === "object"
        ? ctx.order
        : null;

  const line = ctx.line && typeof ctx.line === "object" ? ctx.line : null;
  const orderLineCount = Array.isArray(orderRaw?.order_items) ? orderRaw.order_items.length : 1;
  const discountFin = resolveMercadoLivreDiscountsFinancials(
    ctx.discounts_snapshot,
    ctx.external_order_item_id ?? null,
    line,
    orderLineCount,
  );

  const explicitPct = resolveExplicitSaleFeePercentage(line, orderRaw);
  const historicalGross = resolveHistoricalSaleFeeGross({
    line,
    order: orderRaw,
    item: ctx.item ?? null,
    listing_type_id: listingTypeId,
    sale_price_brl: salePrice,
    qty: ctx.qty ?? 1,
    unit_price_brl: ctx.unit_price_brl ?? null,
    discounts_snapshot: ctx.discounts_snapshot,
    external_order_item_id: ctx.external_order_item_id ?? null,
  });

  const qty =
    ctx.qty != null && ctx.qty > 1
      ? Math.trunc(ctx.qty)
      : line != null
        ? Math.max(1, Math.trunc(parseMlMoney(line.quantity) ?? 1))
        : 1;

  const promoMatch =
    salePrice !== ""
      ? tryCatalogRateForPromotionalSale({
          line,
          sale_price_brl: salePrice,
          sale_fee_subsidy_brl: discountFin.sale_fee_subsidy_brl,
        })
      : null;

  let amountBrl = historicalGross.amount_brl;
  let rawAmountSourcePath = historicalGross.raw_amount_source_path;
  let percentage = explicitPct.percentage;
  let rawPercentageSourcePath = explicitPct.raw_percentage_source_path;
  let percentageSource =
    percentage != null ? /** @type {const} */ ("explicit_from_marketplace") : null;
  let isEstimated = false;

  const skipPromoOverride =
    !!explicitPct.percentage ||
    (line != null &&
      qty > 1 &&
      preferSaleFeeTimesQtyOverCatalogPromo(line, qty, salePrice, listingTypeId));

  if (promoMatch && !skipPromoOverride) {
    amountBrl = promoMatch.amount_brl;
    percentage = promoMatch.percentage;
    percentageSource = "explicit_from_marketplace";
    rawAmountSourcePath = promoMatch.raw_amount_source_path;
    rawPercentageSourcePath = promoMatch.raw_percentage_source_path;
  }

  if (percentage == null && amountBrl != null && salePrice !== "") {
    const calculated = calculateEffectiveMarketplaceFeePercentage({
      fee_amount_brl: amountBrl,
      sale_price_brl: salePrice,
    });
    if (calculated) {
      percentage = calculated;
      percentageSource = "calculated_from_real_fee";
      rawPercentageSourcePath = "derived:fee_amount_brl/sale_price_brl*100";
    }
  }

  if (explicitPct.percentage && amountBrl == null && salePrice !== "") {
    const fromPct = mercadoLivreFeeFromPercentOfGross(new Decimal(salePrice), explicitPct.percentage, {
      qty: ctx.qty ?? 1,
      unitPriceDec:
        ctx.unit_price_brl != null && parseMlMoney(ctx.unit_price_brl) != null
          ? new Decimal(parseMlMoney(ctx.unit_price_brl))
          : null,
    });
    if (fromPct != null) {
      amountBrl = moneyDecimal(fromPct);
      rawAmountSourcePath = "derived:explicit_percent_times_sale_price";
    }
  }

  if (amountBrl == null && norm.default_percent && salePrice !== "") {
    percentage = norm.default_percent;
    percentageSource = "fallback_listing_type";
    rawPercentageSourcePath = `fallback:listing_type_${norm.listing_type}`;
    isEstimated = true;
    const fromFallback = mercadoLivreFeeFromPercentOfGross(new Decimal(salePrice), percentage, {
      qty: ctx.qty ?? 1,
      unitPriceDec:
        ctx.unit_price_brl != null && parseMlMoney(ctx.unit_price_brl) != null
          ? new Decimal(parseMlMoney(ctx.unit_price_brl))
          : null,
    });
    if (fromFallback != null) {
      amountBrl = moneyDecimal(fromFallback);
      rawAmountSourcePath = "fallback:listing_type_default_percent";
    }
  }

  if (percentage == null && amountBrl == null) {
    isEstimated = true;
  }

  const nowIso = new Date().toISOString();

  return {
    source: "mercado_livre",
    listing_type: norm.listing_type,
    listing_type_label: listingTypeLabel,
    amount_brl: amountBrl,
    percentage,
    percentage_source: percentageSource,
    calculation_base_brl: salePrice !== "" ? salePrice : null,
    is_estimated: isEstimated,
    raw_percentage_source_path: rawPercentageSourcePath,
    raw_amount_source_path: rawAmountSourcePath,
    percent_source: percentageSource,
    calculation_method: "historical_sale_financial",
    updated_at: nowIso,
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

/** @deprecated use buildMercadoLivreMarketplaceFeeContract */
export function resolveMercadoLivreSaleFeeRate(ctx = {}) {
  const contract = buildMercadoLivreMarketplaceFeeContract({
    sale_price_brl: "0",
    listing_type_id: ctx.listing_type_id,
    line: ctx.item_raw_json ?? ctx.raw_json ?? null,
    order: ctx.order_raw_json ? { raw_json: ctx.order_raw_json } : null,
    listing: ctx.listing ?? null,
  });
  return {
    percentage: contract.percentage,
    listing_type: contract.listing_type,
    listing_type_label: contract.listing_type_label,
    source: contract.percentage_source,
    is_estimated: contract.is_estimated,
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
      percentage_source: "legacy_flat_fields",
      is_estimated: false,
      raw_percentage_source_path: null,
      raw_amount_source_path: "legacy_flat_fields",
      percent_source: "legacy_flat_fields",
      updated_at: fin.updated_at != null ? String(fin.updated_at) : new Date().toISOString(),
    };
  }
  return null;
}
