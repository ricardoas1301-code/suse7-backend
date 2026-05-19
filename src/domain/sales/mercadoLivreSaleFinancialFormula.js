import Decimal from "decimal.js";
import {
  coalesceMercadoLibreItemForMoneyExtract,
  extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails,
  extractSaleFee,
  toFiniteNumber,
} from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import {
  buildMercadoLivreMarketplaceFeeContract,
  normalizeMercadoLivreListingType,
} from "./mercadoLivreMarketplaceFee.js";
import {
  formatMercadoLivreListingTypeLabel,
  mercadoLivreFeeFromPercentOfGross,
  ML_FINANCIAL_SNAPSHOT_VERSION,
} from "./mercadoLivreSaleRevenueRules.js";

/** @param {unknown} v */
function parseMlMoney(v) {
  return toFiniteNumber(v);
}

/** @param {Decimal | null} d */
function moneyDecimal(d) {
  if (!d) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** @param {unknown} v */
function toQty(v) {
  const n = parseMlMoney(v);
  if (n == null) return 1;
  const q = Math.trunc(n);
  return q > 0 ? q : 1;
}

/** @param {Decimal} fee @param {Decimal} gross */
function feePercent(fee, gross) {
  if (gross.isZero()) return null;
  return fee.div(gross).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

/** @param {Decimal} fee @param {Decimal} gross @param {string | null} listingTypeId */
function isFeePlausibleForListing(fee, gross, listingTypeId) {
  if (fee.lte(0) || gross.lte(0)) return false;
  const pct = feePercent(fee, gross);
  if (pct == null) return false;
  const id = String(listingTypeId ?? "").toLowerCase();
  if (id.includes("gold_pro") || id.includes("gold_premium")) {
    return pct >= 8 && pct <= 22;
  }
  if (id.includes("gold_special")) {
    return pct >= 6 && pct <= 20;
  }
  return pct >= 5 && pct <= 28;
}

/** @param {Decimal} ship @param {Decimal | null} gross */
function isShippingPlausible(ship, gross) {
  if (ship.lte(0)) return false;
  if (!gross || gross.lte(0)) return true;
  if (ship.gte(gross)) return false;
  return ship.div(gross).lte(0.55);
}

/**
 * Frete real do seller: list_cost - cost (Mercado Livre).
 * @param {unknown} shipment
 * @param {Decimal | null} grossDec
 */
export function resolveMercadoLivreShippingSellerCost(shipment, grossDec = null) {
  /** @type {Record<string, number | null>} */
  const candidates = {
    base_cost: null,
    "shipping_option.list_cost": null,
    "shipping_option.cost": null,
    list_minus_cost: null,
    "cost_components.ratio": null,
  };

  if (!shipment || typeof shipment !== "object") {
    return { amount: null, source: null, candidates };
  }

  const s = /** @type {Record<string, unknown>} */ (shipment);
  candidates.base_cost = parseMlMoney(s.base_cost);

  const shippingOption =
    s.shipping_option && typeof s.shipping_option === "object"
      ? /** @type {Record<string, unknown>} */ (s.shipping_option)
      : null;

  if (shippingOption) {
    const listCost = parseMlMoney(shippingOption.list_cost);
    const cost = parseMlMoney(shippingOption.cost);
    candidates["shipping_option.list_cost"] = listCost;
    candidates["shipping_option.cost"] = cost;
    if (listCost != null && cost != null && listCost >= cost) {
      candidates.list_minus_cost = Math.round((listCost - cost) * 100) / 100;
    }
  }

  const costComponents = s.cost_components;
  if (costComponents && typeof costComponents === "object") {
    const ratio = parseMlMoney(/** @type {Record<string, unknown>} */ (costComponents).ratio);
    if (ratio != null && grossDec != null && !grossDec.isZero()) {
      candidates["cost_components.ratio"] = Math.round(ratio * grossDec.toNumber() * 100) / 100;
    }
  }

  const listMinus = candidates.list_minus_cost;
  if (listMinus != null && listMinus > 0) {
    const shipDec = new Decimal(listMinus);
    if (isShippingPlausible(shipDec, grossDec)) {
      return { amount: listMinus, source: "shipping_option.list_cost_minus_cost", candidates };
    }
  }

  const ratioAmt = candidates["cost_components.ratio"];
  if (ratioAmt != null && ratioAmt > 0) {
    const shipDec = new Decimal(ratioAmt);
    if (isShippingPlausible(shipDec, grossDec)) {
      if (listMinus == null || Math.abs(ratioAmt - listMinus) <= 0.15) {
        return { amount: ratioAmt, source: "cost_components.ratio", candidates };
      }
    }
  }

  return { amount: null, source: null, candidates };
}

/** @param {unknown} discountsPayload */
function flattenDiscountDetails(discountsPayload) {
  /** @type {Record<string, unknown>[]} */
  const details = [];

  const pushDetail = (row) => {
    if (!row || typeof row !== "object") return;
    details.push(/** @type {Record<string, unknown>} */ (row));
  };

  const walkCoupon = (coupon) => {
    if (!coupon || typeof coupon !== "object") return;
    const c = /** @type {Record<string, unknown>} */ (coupon);
    const inner = c.details;
    if (Array.isArray(inner)) {
      for (const d of inner) pushDetail(d);
    }
    pushDetail(c);
  };

  if (Array.isArray(discountsPayload)) {
    for (const row of discountsPayload) walkCoupon(row);
  } else if (discountsPayload && typeof discountsPayload === "object") {
    const root = /** @type {Record<string, unknown>} */ (discountsPayload);
    const arr = root.details ?? root.results ?? root.discounts ?? root.coupons ?? root.items;
    if (Array.isArray(arr)) {
      for (const row of arr) walkCoupon(row);
    } else {
      walkCoupon(root);
    }
  }

  return details;
}

/**
 * @param {Record<string, unknown> | null | undefined} line
 * @param {string | null | undefined} externalOrderItemId
 */
function collectDiscountLineMatchKeys(line, externalOrderItemId = null) {
  /** @type {string[]} */
  const keys = [];
  const push = (v) => {
    const s = v != null ? String(v).trim() : "";
    if (s && !keys.includes(s)) keys.push(s);
  };

  push(externalOrderItemId);
  if (!line || typeof line !== "object") return keys;

  push(line.id);
  push(line.order_item_id);
  push(line.item_id);
  const item = line.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : null;
  if (item) push(item.id);

  return keys;
}

/**
 * @param {Record<string, unknown>} discountItem
 * @param {string[]} matchKeys
 * @param {number} orderLineCount
 */
function discountItemMatchesLine(discountItem, matchKeys, orderLineCount) {
  if (matchKeys.length === 0) return true;

  const listingId = discountItem.id != null ? String(discountItem.id).trim() : "";
  const orderItemId = discountItem.order_item_id != null ? String(discountItem.order_item_id).trim() : "";
  const elementId = discountItem.element_id != null ? String(discountItem.element_id).trim() : "";

  if (orderItemId && matchKeys.includes(orderItemId)) return true;
  if (listingId && matchKeys.includes(listingId)) return true;
  if (elementId && matchKeys.includes(elementId)) return true;
  if (orderLineCount <= 1) return true;

  return false;
}

/**
 * Ajustes positivos e subsídio de tarifa (funding_mode sale_fee).
 * API ML: GET /orders/:id/discounts → { details: [{ supplier, items: [{ amounts: { total } }] }] }
 *
 * @param {unknown} discountsPayload
 * @param {string | null | undefined} externalOrderItemId
 * @param {Record<string, unknown> | null | undefined} line
 * @param {number} [orderLineCount]
 */
export function resolveMercadoLivreDiscountsFinancials(
  discountsPayload,
  externalOrderItemId = null,
  line = null,
  orderLineCount = 1,
) {
  const matchKeys = collectDiscountLineMatchKeys(line, externalOrderItemId);
  const details = flattenDiscountDetails(discountsPayload);
  const lineCount = orderLineCount > 0 ? Math.trunc(orderLineCount) : 1;

  /** @type {Record<string, unknown>[]} */
  const matched = [];
  let saleFeeSubsidyDec = new Decimal(0);
  let hasSaleFeeSubsidy = false;

  for (const d of details) {
    const supplier =
      d.supplier && typeof d.supplier === "object" ? /** @type {Record<string, unknown>} */ (d.supplier) : {};
    const funding = String(supplier.funding_mode ?? d.funding_mode ?? "").trim().toLowerCase();

    const discountItems = Array.isArray(d.items) ? d.items : [];
    if (discountItems.length > 0) {
      for (const rawItem of discountItems) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const it = /** @type {Record<string, unknown>} */ (rawItem);
        if (!discountItemMatchesLine(it, matchKeys, lineCount)) continue;

        const amounts =
          it.amounts && typeof it.amounts === "object" ? /** @type {Record<string, unknown>} */ (it.amounts) : {};
        const amt = parseMlMoney(amounts.total ?? amounts.seller ?? it.amount ?? d.amount);
        if (amt == null || amt <= 0) continue;

        matched.push({
          funding_mode: funding || null,
          amount: amt,
          item_id: it.id != null ? String(it.id) : null,
          source: "items.amounts.total",
        });

        if (funding === "sale_fee") {
          saleFeeSubsidyDec = saleFeeSubsidyDec.plus(amt);
          hasSaleFeeSubsidy = true;
        }
      }
      continue;
    }

    const amt = parseMlMoney(d.amount ?? d.value ?? d.coupon_amount ?? d.total);
    if (amt == null || amt <= 0) continue;

    matched.push({ funding_mode: funding || null, amount: amt, source: "detail.amount" });

    if (funding === "sale_fee") {
      saleFeeSubsidyDec = saleFeeSubsidyDec.plus(amt);
      hasSaleFeeSubsidy = true;
    }
  }

  let positiveOnlyDec = new Decimal(0);
  for (const row of matched) {
    const funding = String(row.funding_mode ?? "").toLowerCase();
    const amt = parseMlMoney(row.amount);
    if (amt == null || amt <= 0) continue;
    if (funding === "sale_fee") continue;
    if (/coupon|cashback|credit|rebate|bonus|campaign|promo|discount/.test(funding) || funding === "") {
      positiveOnlyDec = positiveOnlyDec.plus(amt);
    }
  }

  const positiveDec = hasSaleFeeSubsidy ? saleFeeSubsidyDec : positiveOnlyDec.gt(0) ? positiveOnlyDec : null;

  return {
    details: matched,
    sale_fee_subsidy_brl: hasSaleFeeSubsidy ? moneyDecimal(saleFeeSubsidyDec) : null,
    positive_adjustments_brl: positiveDec != null ? moneyDecimal(positiveDec) : null,
  };
}

/**
 * @param {Decimal} grossDec
 * @param {string | null} listingTypeId
 * @param {number} qty
 * @param {number | null} unit
 */
function resolveListingPercentFeeGross(grossDec, listingTypeId, qty, unit) {
  const norm = normalizeMercadoLivreListingType(listingTypeId);
  const hints = norm.default_percent ? [Number(norm.default_percent)] : [];

  for (const hintPct of hints) {
    const fromHint = mercadoLivreFeeFromPercentOfGross(grossDec, hintPct, {
      qty,
      unitPriceDec: unit != null ? new Decimal(unit) : null,
    });
    if (fromHint != null && isFeePlausibleForListing(fromHint, grossDec, listingTypeId)) {
      return fromHint;
    }
  }
  return null;
}

/**
 * @param {{
 *   feeGrossDec: Decimal | null;
 *   feeNetDec: Decimal | null;
 *   positiveDec: Decimal | null;
 *   grossDec: Decimal;
 *   listingTypeId: string | null;
 *   line: Record<string, unknown>;
 *   qty: number;
 *   unit: number | null;
 * }} ctx
 */
export function applyMercadoLivreFeeGrossNetSplit(ctx) {
  let { feeGrossDec, feeNetDec, positiveDec, grossDec, listingTypeId, line, qty, unit } = ctx;

  if (positiveDec != null && positiveDec.gt(0) && feeGrossDec != null) {
    const hintGross = resolveListingPercentFeeGross(grossDec, listingTypeId, qty, unit);
    if (hintGross != null && feeGrossDec.minus(hintGross).abs().lte(0.03)) {
      feeNetDec = feeGrossDec.minus(positiveDec);
      if (feeNetDec.lte(0)) feeNetDec = feeGrossDec;
      return { feeGrossDec, feeNetDec, positiveDec, positiveSource: "discounts_sale_fee_subsidy" };
    }

    const impliedGross = feeGrossDec.plus(positiveDec);
    if (
      isFeePlausibleForListing(impliedGross, grossDec, listingTypeId) &&
      !isFeePlausibleForListing(feeGrossDec, grossDec, listingTypeId)
    ) {
      feeNetDec = feeGrossDec;
      feeGrossDec = impliedGross;
      return { feeGrossDec, feeNetDec, positiveDec, positiveSource: "discounts_sale_fee_subsidy" };
    }
  }

  if (positiveDec == null && feeGrossDec != null) {
    const fromDetails = extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails(line.sale_fee_details);
    if (fromDetails != null && fromDetails > 0) {
      positiveDec = new Decimal(fromDetails);
      const impliedGross = feeGrossDec.plus(positiveDec);
      if (isFeePlausibleForListing(impliedGross, grossDec, listingTypeId)) {
        feeNetDec = feeGrossDec;
        feeGrossDec = impliedGross;
        return { feeGrossDec, feeNetDec, positiveDec, positiveSource: "line.sale_fee_details" };
      }
      positiveDec = null;
    }
  }

  return { feeGrossDec, feeNetDec, positiveDec, positiveSource: positiveDec != null ? "discounts_or_line" : null };
}

/**
 * Tarifa cheia (exibida no Raio-X). Nunca subtrai estorno/subsídio sale_fee aqui.
 *
 * @param {Record<string, unknown>} order
 * @param {Record<string, unknown>} line
 * @param {Decimal} grossDec
 * @param {number} qty
 * @param {number | null} unit
 * @param {string | null} listingTypeId
 * @param {Decimal | null} saleFeeSubsidyDec
 */
export function resolveMercadoLivreSaleFeeGross(order, line, grossDec, qty, unit, listingTypeId, saleFeeSubsidyDec) {
  /** @type {Array<{ source: string; amount: string | null; percent: number | null; valid: boolean }>} */
  const feeCandidates = [];

  const pushCandidate = (source, feeDec) => {
    const valid = feeDec != null && isFeePlausibleForListing(feeDec, grossDec, listingTypeId);
    feeCandidates.push({
      source,
      amount: feeDec != null ? moneyDecimal(feeDec) : null,
      percent: feeDec != null ? feePercent(feeDec, grossDec) : null,
      valid,
    });
    return valid ? feeDec : null;
  };

  const payments = order.payments;
  if (Array.isArray(payments)) {
    let feeSum = new Decimal(0);
    let any = false;
    for (const p of payments) {
      if (!p || typeof p !== "object") continue;
      const pay = /** @type {Record<string, unknown>} */ (p);
      const feeDetails =
        pay.fee_details && typeof pay.fee_details === "object"
          ? /** @type {Record<string, unknown>} */ (pay.fee_details)
          : null;
      const fee = parseMlMoney(
        pay.marketplace_fee ?? pay.marketplace_fee_amount ?? feeDetails?.marketplace_fee ?? pay.sale_fee,
      );
      if (fee != null && fee > 0) {
        feeSum = feeSum.plus(fee);
        any = true;
      }
    }
    if (any) {
      let orderGross = parseMlMoney(order.total_amount ?? order.paid_amount);
      if (orderGross == null && Array.isArray(order.order_items)) {
        let sum = 0;
        for (const it of order.order_items) {
          const g = parseMlMoney(it?.total_amount);
          if (g != null) sum += g;
        }
        if (sum > 0) orderGross = sum;
      }
      let feeDec = feeSum;
      if (orderGross != null && orderGross > grossDec.toNumber() + 0.01) {
        feeDec = feeSum.mul(grossDec).div(orderGross);
      }
      const picked = pushCandidate("payments.marketplace_fee", feeDec);
      if (picked) return { fee: picked, source: "payments.marketplace_fee", feeCandidates };
    }
  }

  const rawLineFee = parseMlMoney(line.sale_fee ?? line.listing_fee);
  if (rawLineFee != null) {
    const asLine = new Decimal(rawLineFee);
    const asScaled = qty > 1 ? new Decimal(rawLineFee).mul(qty) : asLine;

    if (saleFeeSubsidyDec != null && saleFeeSubsidyDec.gt(0)) {
      const asGrossLine = asLine.plus(saleFeeSubsidyDec);
      const pickedGrossLine = pushCandidate("line.sale_fee_plus_sale_fee_subsidy", asGrossLine);
      if (pickedGrossLine) {
        return { fee: pickedGrossLine, source: "line.sale_fee_plus_sale_fee_subsidy", feeCandidates };
      }
      if (qty > 1) {
        const asGrossScaled = asScaled.plus(saleFeeSubsidyDec);
        const pickedGrossScaled = pushCandidate("line.sale_fee_x_qty_plus_sale_fee_subsidy", asGrossScaled);
        if (pickedGrossScaled) {
          return { fee: pickedGrossScaled, source: "line.sale_fee_x_qty_plus_sale_fee_subsidy", feeCandidates };
        }
      }
    }

    const pickedLine = pushCandidate("line.sale_fee_as_line_total", asLine);
    if (pickedLine) return { fee: pickedLine, source: "line.sale_fee_as_line_total", feeCandidates };

    const pickedScaled = pushCandidate("line.sale_fee_x_qty", asScaled);
    if (pickedScaled) return { fee: pickedScaled, source: "line.sale_fee_x_qty", feeCandidates };
  }

  if (line.sale_fee_details) {
    const fromDetails = extractSaleFee(coalesceMercadoLibreItemForMoneyExtract(line), {
      deriveFromPercent: false,
      skipDeepExtract: false,
    });
    if (fromDetails.amount != null && fromDetails.amount > 0) {
      const feeDec = new Decimal(fromDetails.amount);
      const picked = pushCandidate("line.sale_fee_details", feeDec);
      if (picked) return { fee: picked, source: "line.sale_fee_details", feeCandidates };
    }
    if (fromDetails.percent != null && fromDetails.percent > 0) {
      const fromPct = mercadoLivreFeeFromPercentOfGross(grossDec, fromDetails.percent, {
        qty,
        unitPriceDec: unit != null ? new Decimal(unit) : null,
      });
      if (fromPct != null) {
        const picked = pushCandidate(`line.sale_fee_details_percent_${fromDetails.percent}`, fromPct);
        if (picked) return { fee: picked, source: "line.sale_fee_details_percent", feeCandidates };
      }
    }
  }

  return { fee: null, source: null, feeCandidates };
}

/**
 * Resolver determinístico — fonte única do snapshot de enrichment.
 *
 * @param {{
 *   order: Record<string, unknown>;
 *   line: Record<string, unknown>;
 *   shipmentSnapshot?: Record<string, unknown> | null;
 *   discountsSnapshot?: unknown;
 *   externalOrderItemId?: string | null;
 * }} ctx
 */
export function resolveMercadoLivreFinancialFormula(ctx) {
  const { order, line, shipmentSnapshot, discountsSnapshot, externalOrderItemId } = ctx;

  const qty = toQty(line.quantity);
  const unit = parseMlMoney(line.unit_price ?? line.discounted_unit_price);
  const grossNum = parseMlMoney(line.total_amount) ?? (unit != null ? unit * qty : null);
  const grossDec = grossNum != null ? new Decimal(grossNum) : null;

  const listingTypeId =
    line.listing_type_id != null
      ? String(line.listing_type_id).trim()
      : line.item &&
          typeof line.item === "object" &&
          /** @type {Record<string, unknown>} */ (line.item).listing_type_id != null
        ? String(/** @type {Record<string, unknown>} */ (line.item).listing_type_id).trim()
        : null;

  const shipResolved = resolveMercadoLivreShippingSellerCost(shipmentSnapshot, grossDec);
  const shipDec = shipResolved.amount != null ? new Decimal(shipResolved.amount) : null;

  const orderLineCount = Array.isArray(order.order_items) ? order.order_items.length : 1;
  const discountFin = resolveMercadoLivreDiscountsFinancials(
    discountsSnapshot,
    externalOrderItemId,
    line,
    orderLineCount,
  );
  const saleFeeSubsidyDec =
    discountFin.sale_fee_subsidy_brl != null ? new Decimal(discountFin.sale_fee_subsidy_brl) : null;
  let positiveDec =
    discountFin.positive_adjustments_brl != null ? new Decimal(discountFin.positive_adjustments_brl) : null;

  const grossStr = moneyDecimal(grossDec);
  const marketplaceFeeContract =
    grossStr != null
      ? buildMercadoLivreMarketplaceFeeContract({
          sale_price_brl: grossStr,
          listing_type_id: listingTypeId,
          line,
          order,
          qty,
          unit_price_brl: unit != null ? new Decimal(unit).toFixed(2) : null,
          discounts_snapshot,
          external_order_item_id: externalOrderItemId,
        })
      : null;

  let feeResolved =
    grossDec != null
      ? resolveMercadoLivreSaleFeeGross(order, line, grossDec, qty, unit, listingTypeId, saleFeeSubsidyDec)
      : { fee: null, source: null, feeCandidates: [] };

  let feeGrossDec =
    marketplaceFeeContract?.amount_brl != null ? new Decimal(marketplaceFeeContract.amount_brl) : feeResolved.fee;
  if (marketplaceFeeContract?.amount_brl != null) {
    feeResolved = {
      fee: feeGrossDec,
      source: marketplaceFeeContract.percentage_source ?? marketplaceFeeContract.percent_source ?? "marketplace_fee_contract",
      feeCandidates: feeResolved.feeCandidates,
    };
  }
  let feeNetDec = feeGrossDec;
  let positiveSource = null;

  if (grossDec != null && feeGrossDec != null) {
    const split = applyMercadoLivreFeeGrossNetSplit({
      feeGrossDec,
      feeNetDec,
      positiveDec,
      grossDec,
      listingTypeId,
      line,
      qty,
      unit,
    });
    feeGrossDec = split.feeGrossDec;
    feeNetDec = split.feeNetDec;
    positiveDec = split.positiveDec;
    positiveSource = split.positiveSource;
  } else if (feeGrossDec != null && saleFeeSubsidyDec != null && saleFeeSubsidyDec.gt(0)) {
    feeNetDec = feeGrossDec.minus(saleFeeSubsidyDec);
    if (feeNetDec.lte(0)) feeNetDec = feeGrossDec;
  }

  if (positiveDec == null) {
    for (const key of ["coupon_amount", "discount_amount", "meli_discount_amount", "seller_cost_reduction_amount"]) {
      const v = parseMlMoney(line[key]);
      if (v != null && v > 0) {
        positiveDec = new Decimal(v);
        break;
      }
    }
  }

  let netDec = null;
  if (grossDec != null && feeGrossDec != null && shipDec != null) {
    netDec = grossDec.minus(feeGrossDec).minus(shipDec);
    if (positiveDec != null) netDec = netDec.plus(positiveDec);
  }

  const feePercentStr =
    marketplaceFeeContract?.percentage ??
    (feeGrossDec != null && grossDec != null && !grossDec.isZero()
      ? feeGrossDec.div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : null);

  const missingFields = [];
  if (!grossDec) missingFields.push("gross");
  if (!feeGrossDec) missingFields.push("fee");
  if (!shipDec) missingFields.push("shipping");
  if (!netDec) missingFields.push("net");

  const snapshotComplete = missingFields.length === 0;

  const formulaDebug = {
    gross: moneyDecimal(grossDec),
    fee_candidates: feeResolved.feeCandidates,
    selected_fee_gross:
      feeGrossDec != null ? { source: feeResolved.source, amount: moneyDecimal(feeGrossDec) } : null,
    selected_fee_net: feeNetDec != null ? moneyDecimal(feeNetDec) : null,
    shipping_candidates: shipResolved.candidates,
    selected_shipping: shipDec != null ? { source: shipResolved.source, amount: moneyDecimal(shipDec) } : null,
    discounts_details: discountFin.details,
    discounts_payload_shape:
      discountsSnapshot && typeof discountsSnapshot === "object"
        ? {
            has_details: Array.isArray(/** @type {Record<string, unknown>} */ (discountsSnapshot).details),
            details_count: Array.isArray(/** @type {Record<string, unknown>} */ (discountsSnapshot).details)
              ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (discountsSnapshot).details).length
              : 0,
          }
        : null,
    selected_positive_adjustments:
      positiveDec != null ? { amount: moneyDecimal(positiveDec), source: positiveSource ?? "discounts_or_line" } : null,
    final_net: moneyDecimal(netDec),
    snapshot_complete: snapshotComplete,
    missing_fields: missingFields,
  };

  return {
    gross_sale_amount_brl: moneyDecimal(grossDec),
    marketplace_fee: marketplaceFeeContract,
    marketplace_fee_amount_brl: moneyDecimal(feeGrossDec),
    marketplace_fee_net_amount_brl: feeNetDec != null ? moneyDecimal(feeNetDec) : null,
    marketplace_fee_percent: feePercentStr,
    listing_type_id: listingTypeId,
    listing_type_label: formatMercadoLivreListingTypeLabel(listingTypeId),
    shipping_amount_brl: moneyDecimal(shipDec),
    positive_adjustments_brl: positiveDec != null ? moneyDecimal(positiveDec) : null,
    net_received_amount_brl: snapshotComplete ? moneyDecimal(netDec) : null,
    snapshot_version: snapshotComplete ? ML_FINANCIAL_SNAPSHOT_VERSION : null,
    snapshot_complete: snapshotComplete,
    formula_debug: formulaDebug,
    _sources: {
      gross: grossDec != null ? "line.total_or_unit_x_qty" : null,
      fee_gross: feeResolved.source,
      fee_net: feeNetDec != null && feeGrossDec != null && feeNetDec.lt(feeGrossDec) ? "fee_gross_minus_subsidy" : feeResolved.source,
      positive_adjustments: positiveSource,
      shipping: shipResolved.source,
      net: snapshotComplete ? "computed" : null,
    },
  };
}
