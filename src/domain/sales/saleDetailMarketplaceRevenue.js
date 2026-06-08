import Decimal from "decimal.js";
import {
  coalesceMercadoLibreItemForMoneyExtract,
  extractMercadoLivreLogisticsSellerCost,
  extractMercadoLivreOfficialShippingFromListingPricesRow,
  extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails,
  extractSaleFee,
  extractShippingCost,
  parseMlMoneyScalar,
  toFiniteNumber,
} from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import { findMercadoLivreOrderLine, toNum } from "../../handlers/sales/_vendasSalesRows.js";
import {
  buildMercadoLivreMarketplaceFeeContract,
  marketplaceFeeFromFinancialSnapshot,
} from "./mercadoLivreMarketplaceFee.js";
import {
  marketplaceRebateFromFinancialSnapshot,
  resolveMercadoLivreMarketplaceRebate,
} from "./mercadoLivreMarketplaceRebate.js";
import {
  formatMercadoLivreListingTypeLabel,
  mercadoLivreFeeFromPercentOfGross,
  validateMercadoLivreFeeCandidate,
} from "./mercadoLivreSaleRevenueRules.js";
import {
  isMercadoLivreFlexDeliverySale,
  resolveMercadoLivreDiscountsFinancials,
  resolveMercadoLivreShippingBonusForFinancial,
} from "./mercadoLivreSaleFinancialFormula.js";

export { formatMercadoLivreListingTypeLabel };
import {
  extractMarketplaceFeeFromOrderPayments,
  extractPositiveAdjustmentsFromDiscountsSnapshot,
  extractSellerShippingCostFromShipmentSnapshot,
  isFinancialSnapshotVersionCurrent,
} from "../../services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

/** @param {unknown} v */
function parseMlMoney(v) {
  return parseMlMoneyScalar(v);
}

/** @param {unknown} v */
function toDecimal(v) {
  const n = toNum(v);
  if (n == null) return null;
  return new Decimal(n);
}

/** @param {Decimal | null} d */
function moneyDecimal(d) {
  if (!d) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** @param {unknown} v */
function toQty(v) {
  const n = toNum(v);
  if (n == null) return 1;
  const q = Math.trunc(n);
  return q > 0 ? q : 1;
}

/** @param {Decimal} a @param {Decimal} b */
function decimalsClose(a, b, tolerance = 0.05) {
  return a.minus(b).abs().lte(tolerance);
}

function isSalesDetailRevenueDebugEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.S7_SALES_DETAIL_DEBUG === "1";
}

/** @param {Record<string, unknown> | null | undefined} line */
function lineHasSaleFinancialSignals(line) {
  if (!line || typeof line !== "object") return false;
  return (
    parseMlMoney(line.total_amount) != null ||
    parseMlMoney(line.paid_amount) != null ||
    parseMlMoney(line.sale_fee) != null ||
    line.sale_fee_details != null ||
    parseMlMoney(line.shipping_cost_share) != null
  );
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 */
export function resolveEffectiveMercadoLivreSaleLine(item, order) {
  const itemLine =
    item.raw_json && typeof item.raw_json === "object" ? /** @type {Record<string, unknown>} */ (item.raw_json) : null;
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;
  const extItem =
    item.external_order_item_id != null
      ? String(item.external_order_item_id).trim()
      : item.external_item_id != null
        ? String(item.external_item_id).trim()
        : "";
  const extListing = item.external_listing_id != null ? String(item.external_listing_id).trim() : "";
  const orderLine = findMercadoLivreOrderLine(orderRaw, extItem || null, extListing || null);

  if (orderLine && lineHasSaleFinancialSignals(orderLine)) return orderLine;
  if (itemLine && lineHasSaleFinancialSignals(itemLine)) return itemLine;
  return orderLine ?? itemLine;
}

/**
 * @param {Record<string, unknown> | null | undefined} line
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function resolveListingTypeId(line, listing) {
  if (line?.listing_type_id != null) return String(line.listing_type_id).trim();
  const itemObj = line?.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : null;
  if (itemObj?.listing_type_id != null) return String(itemObj.listing_type_id).trim();
  if (listing?.listing_type_id != null) return String(listing.listing_type_id).trim();
  const raw = listing?.raw_json && typeof listing.raw_json === "object" ? /** @type {Record<string, unknown>} */ (listing.raw_json) : null;
  if (raw?.listing_type_id != null) return String(raw.listing_type_id).trim();
  return null;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} line
 */
export function resolveSaleQuantity(item, line) {
  const fromLine = line?.quantity != null ? toQty(line.quantity) : null;
  const fromItem = toQty(item.quantity);
  if (fromLine != null && fromLine > 1) return fromLine;
  return fromItem > 0 ? fromItem : 1;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} line
 */
export function resolveSaleUnitPriceBrl(item, line) {
  const fromDb = toDecimal(item.unit_price);
  if (fromDb != null) return fromDb;

  if (!line || typeof line !== "object") return null;

  for (const key of ["discounted_unit_price", "unit_price", "paid_unit_price", "promotional_price"]) {
    const v = parseMlMoney(line[key]);
    if (v != null) return new Decimal(v);
  }

  const itemObj = line.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : null;
  if (itemObj) {
    const promo = parseMlMoney(itemObj.promotional_price);
    if (promo != null) return new Decimal(promo);
  }

  return null;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} line
 */
export function resolveSaleGrossBrl(item, line) {
  const qty = resolveSaleQuantity(item, line);
  const unit = resolveSaleUnitPriceBrl(item, line);
  const unitTotal = unit != null && qty > 0 ? unit.mul(qty) : null;

  if (line && typeof line === "object") {
    for (const key of ["total_amount", "paid_amount", "transaction_amount"]) {
      const total = parseMlMoney(line[key]);
      if (total != null) {
        return { gross: new Decimal(total), source: `line.${key}` };
      }
    }
  }

  if (unitTotal != null) {
    return { gross: unitTotal, source: "unit_price_x_quantity" };
  }

  const persisted = toDecimal(item.gross_amount);
  if (persisted != null) {
    if (unitTotal != null && !decimalsClose(persisted, unitTotal, 0.15)) {
      return { gross: unitTotal, source: "unit_price_x_quantity_over_persisted" };
    }
    return { gross: persisted, source: "persisted_gross_amount" };
  }

  return { gross: null, source: null };
}

/**
 * @param {Record<string, unknown> | null | undefined} line
 * @param {Record<string, unknown> | null | undefined} listing
 */
function pickFeePercentHint(line, listing) {
  if (line?.sale_fee_details) {
    const fromLine = extractSaleFee(coalesceMercadoLibreItemForMoneyExtract(line), {
      deriveFromPercent: false,
      skipDeepExtract: true,
    });
    if (fromLine.percent != null && fromLine.percent > 0) return fromLine.percent;
  }

  const listingRaw =
    listing?.raw_json && typeof listing.raw_json === "object" ? /** @type {Record<string, unknown>} */ (listing.raw_json) : null;
  if (listingRaw) {
    for (const key of ["sale_fee_percent", "marketplace_fee_percent", "fee_percent"]) {
      const v = parseMlMoney(listingRaw[key]);
      if (v != null && v > 0 && v <= 40) return v;
    }
    const health =
      listingRaw.marketplace_listing_health && typeof listingRaw.marketplace_listing_health === "object"
        ? /** @type {Record<string, unknown>} */ (listingRaw.marketplace_listing_health)
        : listingRaw._s7_listing_health && typeof listingRaw._s7_listing_health === "object"
          ? /** @type {Record<string, unknown>} */ (listingRaw._s7_listing_health)
          : null;
    if (health?.sale_fee_percent != null) {
      const v = parseMlMoney(health.sale_fee_percent);
      if (v != null && v > 0 && v <= 40) return v;
    }
  }

  return null;
}

/**
 * @typedef {{ fee: Decimal; source: string; label: string }} FeeCandidate
 * @typedef {{ valid: boolean; reason: string; percent: number | null }} FeeValidation
 */

/**
 * @param {FeeCandidate} candidate
 * @param {Decimal | null} grossDec
 * @param {string | null} listingTypeId
 * @param {number | null} hintPercent
 */
function validateCandidate(candidate, grossDec, listingTypeId, hintPercent) {
  if (!grossDec) return { valid: false, reason: "no_gross", percent: null };
  const v = validateMercadoLivreFeeCandidate(candidate.fee, grossDec, listingTypeId, { hintPercent });
  return { valid: v.valid, reason: v.reason ?? "unknown", percent: v.percent };
}

/**
 * Snapshot persistido via API Orders + Shipments + Discounts.
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} line
 */
function pickPersistedFinancialSnapshot(item) {
  const itemRaw =
    item.raw_json && typeof item.raw_json === "object" ? /** @type {Record<string, unknown>} */ (item.raw_json) : null;
  const fin = itemRaw?._s7_financial;
  if (!fin || typeof fin !== "object") return null;

  const gross = fin.gross_sale_amount_brl != null ? String(fin.gross_sale_amount_brl).trim() : "";
  const fee = fin.marketplace_fee_amount_brl != null ? String(fin.marketplace_fee_amount_brl).trim() : "";
  const shipping = fin.shipping_amount_brl != null ? String(fin.shipping_amount_brl).trim() : "";
  const net = fin.net_received_amount_brl != null ? String(fin.net_received_amount_brl).trim() : "";
  if (fin.snapshot_complete === false) return null;
  if (!isFinancialSnapshotVersionCurrent(/** @type {Record<string, unknown>} */ (fin))) return null;
  if (gross === "" || fee === "" || shipping === "" || net === "") return null;

  return normalizePersistedFinancialFeeFields(/** @type {Record<string, unknown>} */ (fin));
}

/**
 * Compat: snapshots antigos gravaram tarifa líquida em marketplace_fee_amount_brl.
 * @param {Record<string, unknown>} fin
 */
function normalizePersistedFinancialFeeFields(fin) {
  const feeNetStored =
    fin.marketplace_fee_net_amount_brl != null ? String(fin.marketplace_fee_net_amount_brl).trim() : "";
  const positive =
    fin.positive_adjustments_brl != null ? String(fin.positive_adjustments_brl).trim() : "";
  const feeStored = fin.marketplace_fee_amount_brl != null ? String(fin.marketplace_fee_amount_brl).trim() : "";

  if (feeNetStored !== "") {
    return { ...fin };
  }

  if (positive !== "" && feeStored !== "") {
    const feeDec = toDecimal(feeStored);
    const adjDec = toDecimal(positive);
    if (feeDec != null && adjDec != null && adjDec.gt(0)) {
      const impliedGross = feeDec.plus(adjDec);
      return {
        ...fin,
        marketplace_fee_amount_brl: impliedGross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        marketplace_fee_net_amount_brl: feeDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      };
    }
  }

  return { ...fin };
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} line
 * @param {number} qty
 * @param {Decimal | null} grossDec
 * @param {Record<string, unknown> | null | undefined} order
 */
function buildSaleFeeCandidates(item, line, qty, grossDec, order) {
  /** @type {FeeCandidate[]} */
  const candidates = [];

  const snap = pickPersistedFinancialSnapshot(item);
  if (snap?.marketplace_fee_amount_brl != null) {
    const fee = toDecimal(snap.marketplace_fee_amount_brl);
    if (fee != null) {
      candidates.push({
        fee,
        source: "s7_financial_snapshot.fee",
        label: "s7_financial.marketplace_fee_amount_brl",
      });
    }
  }

  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;
  if (orderRaw) {
    const fromPayments = extractMarketplaceFeeFromOrderPayments(orderRaw, line, {
      qty,
      unitPrice: parseMlMoney(line?.unit_price),
    });
    if (fromPayments?.fee != null) {
      candidates.push({
        fee: fromPayments.fee,
        source: "payments.marketplace_fee",
        label: fromPayments.source,
      });
    }
  }

  if (line?.sale_fee_details) {
    const fromDetails = extractSaleFee(coalesceMercadoLibreItemForMoneyExtract(line), {
      deriveFromPercent: false,
      skipDeepExtract: false,
    });
    if (fromDetails.amount != null && fromDetails.amount > 0) {
      candidates.push({
        fee: new Decimal(fromDetails.amount),
        source: "line.sale_fee_details",
        label: "sale_fee_details.amount",
      });
    }
  }

  if (line && typeof line === "object") {
    const rawFee = parseMlMoney(line.sale_fee ?? line.listing_fee);
    if (rawFee != null) {
      const feeDec = new Decimal(rawFee);
      candidates.push({
        fee: feeDec,
        source: "line.sale_fee_as_line_total",
        label: "line.sale_fee(line_total)",
      });
      if (qty > 1) {
        candidates.push({
          fee: feeDec.mul(qty),
          source: "line.sale_fee_x_qty",
          label: `line.sale_fee(${rawFee})x${qty}`,
        });
      }
    }
  }

  const persisted = toDecimal(item.fee_amount);
  if (persisted != null) {
    candidates.push({
      fee: persisted,
      source: "persisted_fee_amount",
      label: "sales_order_items.fee_amount",
    });
  }

  return candidates;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} line
 * @param {Decimal | null} grossDec
 * @param {string | null} listingTypeId
 * @param {Record<string, unknown> | null | undefined} listing
 * @param {Record<string, unknown> | null | undefined} order
 */
function resolveSaleFeeBrl(item, line, grossDec, listingTypeId, listing, order) {
  const qty = resolveSaleQuantity(item, line);
  const unitPriceDec = resolveSaleUnitPriceBrl(item, line);
  const hintPercent = pickFeePercentHint(line, listing);

  /** @type {Array<{ label: string; source: string; amount: string; valid: boolean; reason: string }>} */
  const rejected = [];
  const candidates = buildSaleFeeCandidates(item, line, qty, grossDec, order);

  const priority = [
    "s7_financial_snapshot.fee",
    "payments.marketplace_fee",
    "line.sale_fee_details",
    "line.sale_fee_as_line_total",
    "persisted_fee_amount",
    "line.sale_fee_x_qty",
    "fee_percent_hint_x_gross",
  ];

  /** @type {FeeCandidate | null} */
  let selected = null;

  for (const prio of priority) {
    for (const c of candidates) {
      if (c.source !== prio) continue;
      const validation = validateCandidate(c, grossDec, listingTypeId, hintPercent);
      if (validation.valid) {
        selected = c;
        break;
      }
      rejected.push({
        label: c.label,
        source: c.source,
        amount: moneyDecimal(c.fee) ?? "",
        valid: false,
        reason: validation.reason,
      });
    }
    if (selected) break;
  }

  if (!selected && hintPercent != null && grossDec != null) {
    const fromPct = mercadoLivreFeeFromPercentOfGross(grossDec, hintPercent, {
      qty,
      unitPriceDec: unitPriceDec,
    });
    if (fromPct != null) {
      const pctCandidate = {
        fee: fromPct,
        source: "fee_percent_hint_x_gross",
        label: `percent_hint_${hintPercent}`,
      };
      const validation = validateCandidate(pctCandidate, grossDec, listingTypeId, hintPercent);
      if (validation.valid) {
        selected = pctCandidate;
      } else {
        rejected.push({
          label: pctCandidate.label,
          source: pctCandidate.source,
          amount: moneyDecimal(pctCandidate.fee) ?? "",
          valid: false,
          reason: validation.reason,
        });
      }
    }
  }

  return {
    fee: selected?.fee ?? null,
    source: selected?.source ?? null,
    feePercentHint: hintPercent,
    debug: {
      candidates: candidates.map((c) => ({
        label: c.label,
        source: c.source,
        amount: moneyDecimal(c.fee),
      })),
      rejected,
      selected: selected
        ? { label: selected.label, source: selected.source, amount: moneyDecimal(selected.fee) }
        : null,
    },
  };
}

/**
 * @param {unknown} blob
 * @param {number} [depth]
 */
function deepScanShippingInBlob(blob, depth = 0) {
  if (blob == null || depth > 14) return null;
  /** @type {{ score: number; amount: number } | null} */
  let best = null;

  const consider = (keyPath, raw) => {
    const n = parseMlMoney(raw);
    if (n == null || n <= 0) return;
    const kp = keyPath.toLowerCase();
    let score = 0;
    if (/shipping|ship|envio|frete|logist|delivery/.test(kp)) score += 5;
    if (/seller|to_pay|payer|cost|amount|charge|share/.test(kp)) score += 2;
    if (/sale_fee|commission|percent|fee/.test(kp)) score -= 5;
    if (score <= 0) return;
    if (!best || score > best.score || (score === best.score && n > best.amount)) {
      best = { score, amount: n };
    }
  };

  const walk = (node, path, d) => {
    if (node == null || d > 14) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, d + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
      const p = path ? `${path}.${k}` : k;
      if (v != null && typeof v === "object") walk(v, p, d + 1);
      else consider(p, v);
    }
  };

  walk(blob, "", depth);
  return best?.amount != null && best.amount > 0 ? best.amount : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Decimal | null} lineGrossDec
 */
function resolveProportionalOrderShipping(orderRaw, lineGrossDec) {
  if (!orderRaw || lineGrossDec == null || lineGrossDec.lte(0)) return null;

  const shipping = orderRaw.shipping && typeof orderRaw.shipping === "object" ? /** @type {Record<string, unknown>} */ (orderRaw.shipping) : null;
  const orderShip = parseMlMoney(
    orderRaw.shipping_cost ??
      orderRaw.shipping_amount ??
      shipping?.cost ??
      shipping?.list_cost ??
      shipping?.seller_cost,
  );
  if (orderShip == null || orderShip <= 0) return null;

  const items = orderRaw.order_items;
  if (!Array.isArray(items) || items.length <= 1) {
    return { ship: new Decimal(orderShip), source: "order.shipping_amount" };
  }

  let totalGross = new Decimal(0);
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const g =
      parseMlMoney(it.total_amount) ??
      parseMlMoney(it.paid_amount) ??
      (parseMlMoney(it.unit_price) != null && it.quantity != null
        ? parseMlMoney(it.unit_price) * toQty(it.quantity)
        : null);
    if (g != null && g > 0) totalGross = totalGross.plus(g);
  }

  if (totalGross.lte(0)) return null;
  const share = lineGrossDec.div(totalGross).mul(orderShip);
  return { ship: share, source: "order.shipping_proportional_by_gross" };
}

/**
 * Custo de envio do seller não pode ser >= bruto da linha (evita confundir com total_amount).
 * @param {Decimal} shipDec
 * @param {Decimal | null} grossDec
 */
function isPlausibleShippingAmount(shipDec, grossDec) {
  if (!shipDec || shipDec.lte(0)) return false;
  if (!grossDec || grossDec.lte(0)) return true;
  if (shipDec.gte(grossDec)) return false;
  return shipDec.div(grossDec).lte(0.55);
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} line
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Decimal | null} lineGrossDec
 */
function resolveSaleShippingBrl(item, line, orderRaw, lineGrossDec, order) {
  const orderFin =
    orderRaw?._s7_financial && typeof orderRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (orderRaw._s7_financial)
      : null;
  const shipmentSnapshot = orderFin?.shipment_snapshot;

  if (isMercadoLivreFlexDeliverySale({ order: orderRaw, line, shipmentSnapshot })) {
    return {
      ship: new Decimal(0),
      source: "flex_no_shipping_charge",
      debug: {
        flex_delivery: true,
        shippingCandidates: [],
        selected: { source: "flex_no_shipping_charge", amount: "0.00" },
      },
    };
  }

  /** @type {Array<{ source: string; amount: string | null; shipDec: Decimal }>} */
  const shippingCandidates = [];

  const snap = pickPersistedFinancialSnapshot(item);
  if (snap?.shipping_amount_brl != null) {
    const ship = toDecimal(snap.shipping_amount_brl);
    if (ship != null && isPlausibleShippingAmount(ship, lineGrossDec)) {
      return {
        ship,
        source: "s7_financial_snapshot.shipping",
        debug: {
          shippingCandidates: [{ source: "s7_financial_snapshot.shipping", amount: moneyDecimal(ship) }],
          selected: { source: "s7_financial_snapshot.shipping", amount: moneyDecimal(ship) },
        },
      };
    }
  }

  const pushCandidate = (amount, source) => {
    if (amount == null) return;
    const dec = amount instanceof Decimal ? amount : new Decimal(amount);
    if (dec.lte(0) || !isPlausibleShippingAmount(dec, lineGrossDec)) return;
    shippingCandidates.push({ source, amount: moneyDecimal(dec), shipDec: dec });
  };

  if (shipmentSnapshot) {
    pushCandidate(extractSellerShippingCostFromShipmentSnapshot(shipmentSnapshot), "shipment_api_snapshot");
  }

  const persisted = toDecimal(item.shipping_share_amount);
  pushCandidate(persisted, "persisted_shipping_share");

  if (line && typeof line === "object") {
    pushCandidate(parseMlMoney(line.shipping_cost_share), "line.shipping_cost_share");

    if (line.sale_fee_details) {
      pushCandidate(
        extractMercadoLivreLogisticsSellerCost(line.sale_fee_details, { auditLog: false }),
        "line.sale_fee_details_logistics",
      );
    }

    pushCandidate(
      extractMercadoLivreOfficialShippingFromListingPricesRow(coalesceMercadoLibreItemForMoneyExtract(line), {
        auditLog: false,
      }),
      "line.official_shipping_row_scan",
    );

    pushCandidate(extractShippingCost(coalesceMercadoLibreItemForMoneyExtract(line)), "line.shipping_object");
    pushCandidate(deepScanShippingInBlob(line), "line.deep_scan");
  }

  if (orderRaw && typeof orderRaw === "object") {
    const proportional = resolveProportionalOrderShipping(orderRaw, lineGrossDec);
    if (proportional) pushCandidate(proportional.ship, proportional.source);
    pushCandidate(deepScanShippingInBlob(orderRaw.shipping), "order.shipping.deep_scan");
  }

  const priority = [
    "line.shipping_cost_share",
    "shipment_api_snapshot",
    "line.sale_fee_details_logistics",
    "persisted_shipping_share",
    "order.shipping_amount",
    "order.shipping_proportional_by_gross",
    "line.shipping_object",
    "line.official_shipping_row_scan",
    "line.deep_scan",
    "order.shipping.deep_scan",
  ];

  for (const prio of priority) {
    const hit = shippingCandidates.find((c) => c.source === prio && c.amount != null);
    if (hit) {
      return {
        ship: hit.shipDec,
        source: prio,
        debug: {
          shippingCandidates: shippingCandidates.map((c) => ({ source: c.source, amount: c.amount })),
          selected: { source: hit.source, amount: hit.amount },
        },
      };
    }
  }

  return { ship: null, source: null, debug: { shippingCandidates, selected: null } };
}

/**
 * @param {Record<string, unknown> | null | undefined} line
 */
function pickPositiveAdjustmentsFromLine(line) {
  if (!line || typeof line !== "object") return null;
  /** @type {number[]} */
  const candidates = [];
  for (const key of [
    "coupon_amount",
    "discount_amount",
    "meli_discount_amount",
    "promotional_discount_amount",
    "seller_cost_reduction_amount",
    "cost_reduction_amount",
    "rebate_amount",
    "bonus_amount",
    "compensation_amount",
  ]) {
    const v = parseMlMoney(line[key]);
    if (v != null && v > 0.001) candidates.push(v);
  }
  const fromDetails = extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails(line.sale_fee_details);
  if (fromDetails != null && fromDetails > 0.001) candidates.push(fromDetails);

  const itemObj = line.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : null;
  if (itemObj?.sale_fee_details) {
    const fromItemDetails = extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails(itemObj.sale_fee_details);
    if (fromItemDetails != null && fromItemDetails > 0.001) candidates.push(fromItemDetails);
  }

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function resolveMercadoLivreSaleRevenueSnapshot(item, order, listing = null) {
  const line = resolveEffectiveMercadoLivreSaleLine(item, order);
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;

  const orderFinEarly =
    orderRaw?._s7_financial && typeof orderRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (orderRaw._s7_financial)
      : null;
  const shipmentSnapshotEarly = orderFinEarly?.shipment_snapshot;
  const isFlexDelivery = isMercadoLivreFlexDeliverySale({
    order: orderRaw,
    line,
    shipmentSnapshot: shipmentSnapshotEarly,
  });

  const persistedSnap = pickPersistedFinancialSnapshot(item);
  if (
    persistedSnap?.gross_sale_amount_brl &&
    persistedSnap?.marketplace_fee_amount_brl &&
    persistedSnap?.net_received_amount_brl
  ) {
    const listingTypeId = resolveListingTypeId(line, listing);
    const marketplaceFee = buildMercadoLivreMarketplaceFeeContract({
      sale_price_brl: String(persistedSnap.gross_sale_amount_brl),
      listing_type_id: listingTypeId,
      line: line && typeof line === "object" ? line : null,
      order,
      item,
      listing,
      qty: resolveSaleQuantity(item, line),
      unit_price_brl: resolveSaleUnitPriceBrl(item, line)?.toFixed(2) ?? null,
      discounts_snapshot: orderRaw?._s7_discounts ?? orderRaw?.discounts ?? null,
      external_order_item_id:
        item.external_listing_id != null ? String(item.external_listing_id) : null,
    });
    const feeAmount = marketplaceFee?.amount_brl ?? String(persistedSnap.marketplace_fee_amount_brl);
    const feePercent =
      marketplaceFee?.percentage ??
      (persistedSnap.marketplace_fee_percent != null ? String(persistedSnap.marketplace_fee_percent) : null);
    const feeGrossDec = toDecimal(feeAmount);
    const grossDec = toDecimal(persistedSnap.gross_sale_amount_brl);
    const shipDec = isFlexDelivery
      ? new Decimal(0)
      : persistedSnap.shipping_amount_brl != null
        ? toDecimal(persistedSnap.shipping_amount_brl)
        : null;

    const rebateResolved = resolveMercadoLivreMarketplaceRebate({
      feeGrossDec,
      line: line && typeof line === "object" ? line : null,
      qty: resolveSaleQuantity(item, line),
      logContext: {
        item_id: item.id != null ? String(item.id) : null,
        external_order_id:
          order?.external_order_id != null
            ? String(order.external_order_id)
            : item.external_order_id != null
              ? String(item.external_order_id)
              : null,
      },
    });
    const explicitRebate =
      rebateResolved.marketplace_rebate ?? marketplaceRebateFromFinancialSnapshot(persistedSnap);
    const rebateDec =
      explicitRebate?.amount_brl != null ? toDecimal(explicitRebate.amount_brl) : null;

    const shippingBonusResolved = resolveMercadoLivreShippingBonusForFinancial({
      order: orderRaw,
      line,
      shipmentSnapshot: shipmentSnapshotEarly,
    });
    const shippingBonusDec = shippingBonusResolved.bonusDec;

    let netDec = toDecimal(persistedSnap.net_received_amount_brl);
    if (grossDec != null && feeGrossDec != null && shipDec != null) {
      netDec = grossDec.minus(feeGrossDec).minus(shipDec);
      if (shippingBonusDec != null) netDec = netDec.plus(shippingBonusDec);
      if (rebateDec != null) netDec = netDec.plus(rebateDec);
    }

    return {
      gross_sale_amount_brl: String(persistedSnap.gross_sale_amount_brl),
      marketplace_fee: marketplaceFee,
      marketplace_fee_amount_brl: feeAmount,
      marketplace_fee_net_amount_brl:
        persistedSnap.marketplace_fee_net_amount_brl != null
          ? String(persistedSnap.marketplace_fee_net_amount_brl)
          : null,
      marketplace_fee_percent: feePercent,
      listing_type_id: listingTypeId,
      listing_type_label:
        marketplaceFee?.listing_type_label ?? formatMercadoLivreListingTypeLabel(listingTypeId),
      shipping_amount_brl: isFlexDelivery
        ? "0.00"
        : persistedSnap.shipping_amount_brl != null
          ? String(persistedSnap.shipping_amount_brl)
          : null,
      shipping_bonus_brl: moneyDecimal(shippingBonusDec),
      marketplace_rebate: explicitRebate,
      positive_adjustments_brl: rebateDec != null ? moneyDecimal(rebateDec) : null,
      net_received_amount_brl: moneyDecimal(netDec),
      net_received_source: "s7_financial_snapshot",
      _sources: {
        gross: "s7_financial_snapshot",
        fee_gross: "s7_financial_snapshot",
        fee_net:
          persistedSnap.marketplace_fee_net_amount_brl != null
            ? "s7_financial_snapshot"
            : persistedSnap.positive_adjustments_brl != null
              ? "derived_from_gross_minus_subsidy"
              : null,
        shipping: isFlexDelivery ? "flex_no_shipping_charge" : "s7_financial_snapshot",
        shipping_bonus: shippingBonusResolved.source,
        positive_adjustments: "s7_financial_snapshot",
        net: "s7_financial_snapshot",
        line: "s7_financial_snapshot",
      },
      _debug: { from_snapshot: true, sources: persistedSnap.sources ?? null },
    };
  }

  const { gross: grossDec, source: grossSource } = resolveSaleGrossBrl(item, line);
  const listingTypeId = resolveListingTypeId(line, listing);

  const grossStr = moneyDecimal(grossDec);
  const qty = resolveSaleQuantity(item, line);
  const unitPrice = resolveSaleUnitPriceBrl(item, line);
  const marketplaceFee =
    grossStr != null
      ? buildMercadoLivreMarketplaceFeeContract({
          sale_price_brl: grossStr,
          listing_type_id: listingTypeId,
          line: line && typeof line === "object" ? line : null,
          order,
          item,
          listing,
          qty,
          unit_price_brl: unitPrice != null ? unitPrice.toFixed(2) : null,
          discounts_snapshot: orderRaw?._s7_discounts ?? orderRaw?.discounts ?? null,
          external_order_item_id:
            item.external_listing_id != null ? String(item.external_listing_id) : null,
        })
      : null;

  const feeResult = resolveSaleFeeBrl(item, line, grossDec, listingTypeId, listing, order);
  const feeDec =
    marketplaceFee?.amount_brl != null ? new Decimal(marketplaceFee.amount_brl) : feeResult.fee;
  const feeSource = marketplaceFee?.percentage_source ?? marketplaceFee?.percent_source ?? feeResult.source;

  const shipResult = resolveSaleShippingBrl(item, line, orderRaw, grossDec, order);
  const shipDec = shipResult.ship;
  const shipSource = shipResult.source;

  const shippingBonusResolved = resolveMercadoLivreShippingBonusForFinancial({
    order: orderRaw,
    line,
    shipmentSnapshot: shipmentSnapshotEarly,
  });
  const shippingBonusDec = shippingBonusResolved.bonusDec;

  const feePercentStr =
    marketplaceFee?.percentage ??
    (feeResult.feePercentHint != null
      ? new Decimal(feeResult.feePercentHint).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : feeDec != null && grossDec != null && !grossDec.isZero()
        ? feeDec.div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
        : null);

  const listingTypeLabel =
    marketplaceFee?.listing_type_label ?? formatMercadoLivreListingTypeLabel(listingTypeId);

  const rebateResolved = resolveMercadoLivreMarketplaceRebate({
    feeGrossDec: feeDec,
    line: line && typeof line === "object" ? line : null,
    qty,
    logContext: {
      item_id: item.id != null ? String(item.id) : null,
      external_order_id:
        order?.external_order_id != null
          ? String(order.external_order_id)
          : item.external_order_id != null
            ? String(item.external_order_id)
            : null,
    },
  });
  const explicitRebate = rebateResolved.marketplace_rebate;
  const positiveAdjDec =
    explicitRebate?.amount_brl != null ? toDecimal(explicitRebate.amount_brl) : null;
  const positiveSource = explicitRebate?.raw_source_path ?? null;

  let netDec = null;
  /** @type {"computed" | null} */
  let netSource = null;
  if (grossDec != null && feeDec != null) {
    let computed = grossDec.minus(feeDec);
    if (shipDec != null) computed = computed.minus(shipDec);
    if (shippingBonusDec != null) computed = computed.plus(shippingBonusDec);
    if (positiveAdjDec != null) computed = computed.plus(positiveAdjDec);
    netDec = computed;
    netSource = "computed";
  }

  const debugPayload = {
    gross_source: grossSource,
    fee: feeResult.debug,
    shipping: shipResult.debug,
    shipping_bonus_source: shippingBonusResolved.source,
    positive_adjustments_source: positiveSource,
    net_calculation: {
      gross: moneyDecimal(grossDec),
      fee: moneyDecimal(feeDec),
      shipping: moneyDecimal(shipDec),
      shipping_bonus: moneyDecimal(shippingBonusDec),
      positive_adjustments: moneyDecimal(positiveAdjDec),
      net: moneyDecimal(netDec),
      formula: "gross - fee - shipping + shipping_bonus + positive_adjustments",
    },
  };

  if (isSalesDetailRevenueDebugEnabled()) {
    console.log("[sales/detail] marketplace_revenue_source_debug", debugPayload);
  }

  return {
    gross_sale_amount_brl: moneyDecimal(grossDec),
    marketplace_fee: marketplaceFee,
    marketplace_fee_amount_brl: moneyDecimal(feeDec),
    marketplace_fee_percent: feePercentStr,
    listing_type_id: listingTypeId,
    listing_type_label: listingTypeLabel,
    shipping_amount_brl: moneyDecimal(shipDec),
    shipping_bonus_brl: moneyDecimal(shippingBonusDec),
    marketplace_rebate: explicitRebate,
    positive_adjustments_brl: moneyDecimal(positiveAdjDec),
    net_received_amount_brl: moneyDecimal(netDec),
    net_received_source: netSource,
    _sources: {
      gross: grossSource,
      fee: feeSource,
      shipping: shipSource,
      shipping_bonus: shippingBonusResolved.source,
      positive_adjustments: positiveSource,
      line: line ? "order_or_item_line" : null,
    },
    _debug: debugPayload,
  };
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function resolveSaleMarketplaceRevenue(item, order, listing = null) {
  const marketplace = String(item.marketplace ?? "")
    .trim()
    .toLowerCase();
  if (marketplace === "mercado_livre" || marketplace === "mercadolivre") {
    return resolveMercadoLivreSaleRevenueSnapshot(item, order, listing);
  }
  return resolveMercadoLivreSaleRevenueSnapshot(item, order, listing);
}

/** @param {string} s */
function isTechnicalPromotionToken(s) {
  const t = s.trim();
  if (!t) return true;
  if (/^promo[cç][aã]o\s*\(/i.test(t)) return true;
  if (/^offer-/i.test(t)) return true;
  if (/^p-ml[bai]/i.test(t)) return true;
  return false;
}

/** @param {Record<string, unknown>} detail */
function humanizeDiscountDetailName(detail) {
  const supplier =
    detail.supplier && typeof detail.supplier === "object"
      ? /** @type {Record<string, unknown>} */ (detail.supplier)
      : {};
  const meta =
    detail.metadata && typeof detail.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (detail.metadata)
      : {};

  for (const key of ["promotion_name", "campaign_name", "name", "title", "label"]) {
    const raw = meta[key] ?? supplier[key] ?? detail[key];
    if (raw == null) continue;
    const s = String(raw).trim();
    if (s && !isTechnicalPromotionToken(s)) return s;
  }

  const typeRaw = String(detail.type ?? meta.promotion_type ?? supplier.promotion_type ?? "")
    .trim()
    .toLowerCase();
  const discountType = String(meta.discount_type ?? supplier.discount_type ?? "")
    .trim()
    .toLowerCase();

  if (
    typeRaw.includes("percent") ||
    typeRaw.includes("porcentagem") ||
    discountType.includes("percent") ||
    discountType.includes("porcentagem") ||
    typeRaw === "custom"
  ) {
    return "Desconto por porcentagem";
  }

  if (typeRaw.includes("price_discount") || (typeRaw.includes("price") && typeRaw.includes("discount"))) {
    return "Desconto no preço";
  }

  if (typeRaw === "discount") return "Desconto por porcentagem";

  const meli = supplier.meli_campaign != null ? String(supplier.meli_campaign).trim() : "";
  if (meli && !/^p-ml[bai]/i.test(meli)) return meli;

  return null;
}

/** @param {unknown} discountsPayload */
function flattenSaleDiscountDetails(discountsPayload) {
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
 * @param {Record<string, unknown>} discountItem
 * @param {string[]} matchKeys
 * @param {number} orderLineCount
 */
function saleDiscountItemMatchesLine(discountItem, matchKeys, orderLineCount) {
  if (matchKeys.length === 0) return orderLineCount <= 1;

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
 * @param {Record<string, unknown> | null | undefined} line
 * @param {string | null | undefined} externalOrderItemId
 * @param {string | null | undefined} externalListingId
 */
function collectSaleDiscountLineMatchKeys(line, externalOrderItemId = null, externalListingId = null) {
  /** @type {string[]} */
  const keys = [];
  const push = (v) => {
    const s = v != null ? String(v).trim() : "";
    if (s && !keys.includes(s)) keys.push(s);
  };

  push(externalOrderItemId);
  push(externalListingId);
  if (!line || typeof line !== "object") return keys;

  push(line.id);
  push(line.order_item_id);
  push(line.item_id);
  const item = line.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : null;
  if (item) {
    push(item.id);
    push(item.item_id);
  }

  return keys;
}

/**
 * @param {number} amount
 * @param {Record<string, unknown> | null | undefined} line
 * @param {number} qty
 */
function isSaleItemPriceGapMislabeledAsSaleFee(amount, line, qty) {
  if (!line || amount == null || amount <= 0) return false;
  const unit = parseMlMoney(line.unit_price ?? line.discounted_unit_price);
  const grossPrice = parseMlMoney(line.gross_price);
  if (unit == null || grossPrice == null) return false;
  const q = qty > 0 ? Math.trunc(qty) : 1;
  const saleLineTotal = unit * q;
  if (grossPrice <= saleLineTotal + 0.01) return false;
  return Math.abs(grossPrice - saleLineTotal - amount) <= 0.08;
}

/** @param {Record<string, unknown> | null | undefined} order */
function resolveOrderDiscountsSnapshot(order) {
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;
  if (!orderRaw) return null;

  const fin =
    orderRaw._s7_financial && typeof orderRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (orderRaw._s7_financial)
      : null;

  return fin?.discounts_snapshot ?? orderRaw._s7_discounts ?? orderRaw.discounts ?? null;
}

/** @param {Decimal} originalDec @param {Decimal} saleDec */
function deriveSaleDiscountPercentString(originalDec, saleDec) {
  if (originalDec.lte(0) || saleDec.gte(originalDec)) return null;
  const pct = originalDec.minus(saleDec).div(originalDec).mul(100);
  const rounded = pct.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const asInt = rounded.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (rounded.minus(asInt).abs().lte(new Decimal("0.04"))) {
    return asInt.toFixed(0);
  }
  return rounded.toFixed(2);
}

/**
 * Mescla campos de preço da linha canônica do pedido ML (order_items) quando o snapshot do item não tem gross_price.
 *
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} line
 */
function mergeOrderLinePricingFields(item, order, line) {
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;
  if (!orderRaw) return line;

  const extItem =
    item.external_order_item_id != null
      ? String(item.external_order_item_id).trim()
      : item.external_item_id != null
        ? String(item.external_item_id).trim()
        : "";
  const extListing = item.external_listing_id != null ? String(item.external_listing_id).trim() : "";
  const orderLine = findMercadoLivreOrderLine(orderRaw, extItem || null, extListing || null);
  if (!orderLine) return line;

  const base = line && typeof line === "object" ? { ...line } : { ...orderLine };
  for (const key of [
    "gross_price",
    "full_unit_price",
    "base_unit_price",
    "original_unit_price",
    "unit_price",
    "discounted_unit_price",
    "quantity",
  ]) {
    if (parseMlMoney(base[key]) == null && parseMlMoney(orderLine[key]) != null) {
      base[key] = orderLine[key];
    }
  }
  if ((!base.item || typeof base.item !== "object") && orderLine.item && typeof orderLine.item === "object") {
    base.item = orderLine.item;
  }
  return base;
}

/**
 * Valor do desconto de preço aplicado na linha (GET /orders/:id/discounts), sem cupom/cashback.
 *
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} line
 * @param {number} qty
 */
function resolveLinePriceDiscountAmountBrl(item, order, line, qty) {
  const snapshot = resolveOrderDiscountsSnapshot(order);
  if (snapshot == null) return null;

  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;
  const orderLineCount = Array.isArray(orderRaw?.order_items) ? orderRaw.order_items.length : 1;

  const externalOrderItemId =
    item.external_order_item_id != null ? String(item.external_order_item_id).trim() : null;
  const externalListingId = item.external_listing_id != null ? String(item.external_listing_id).trim() : null;

  const matchKeys = collectSaleDiscountLineMatchKeys(line, externalOrderItemId, externalListingId);
  const details = flattenSaleDiscountDetails(snapshot);
  let best = 0;

  for (const d of details) {
    const type = String(d.type ?? "").trim().toLowerCase();
    if (type === "coupon" || type === "cashback") continue;

    const discountItems = Array.isArray(d.items) ? d.items : [];
    let amountForLine = 0;

    if (discountItems.length > 0) {
      for (const rawItem of discountItems) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const it = /** @type {Record<string, unknown>} */ (rawItem);
        if (!saleDiscountItemMatchesLine(it, matchKeys, orderLineCount)) continue;
        const amounts =
          it.amounts && typeof it.amounts === "object" ? /** @type {Record<string, unknown>} */ (it.amounts) : {};
        const amt = parseMlMoney(amounts.total ?? amounts.seller ?? it.amount ?? d.amount);
        if (amt != null && amt > 0) amountForLine += amt;
      }
    } else {
      const amt = parseMlMoney(d.amount ?? d.value ?? d.coupon_amount ?? d.total);
      if (amt != null && amt > 0) amountForLine = amt;
    }

    if (amountForLine > best) best = amountForLine;
  }

  return best > 0 ? best : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} line
 * @param {number} qty
 * @param {Decimal} saleGrossDec
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 */
function resolveOriginalProductPriceDec(line, qty, saleGrossDec, item, order) {
  if (!line || typeof line !== "object") return null;

  const q = qty > 0 ? Math.trunc(qty) : 1;
  const unitSale = parseMlMoney(line.unit_price ?? line.discounted_unit_price ?? line.paid_unit_price);
  const saleUnitDec =
    unitSale != null
      ? new Decimal(unitSale)
      : q > 0
        ? saleGrossDec.div(q)
        : saleGrossDec;

  const itemObj =
    line.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : null;

  /** @type {number[]} */
  const catalogUnitCandidates = [];
  for (const key of ["full_unit_price", "base_unit_price", "original_unit_price"]) {
    const v = parseMlMoney(line[key]);
    if (v != null && v > 0) catalogUnitCandidates.push(v);
  }
  if (itemObj) {
    for (const key of ["original_price", "full_price", "base_price"]) {
      const v = parseMlMoney(itemObj[key]);
      if (v != null && v > 0) catalogUnitCandidates.push(v);
    }
  }

  for (const catalogUnit of catalogUnitCandidates) {
    if (catalogUnit <= saleUnitDec.toNumber() + 0.01) continue;
    const originalDec = new Decimal(catalogUnit).mul(q);
    if (originalDec.gt(saleGrossDec)) return originalDec;
  }

  const grossPrice = parseMlMoney(line.gross_price);
  if (grossPrice != null && grossPrice > 0) {
    const originalDec = new Decimal(grossPrice);
    if (originalDec.gt(saleGrossDec)) return originalDec;
  }

  const lineDiscounts =
    line.discounts && typeof line.discounts === "object"
      ? /** @type {Record<string, unknown>} */ (line.discounts)
      : null;
  const discountFull = parseMlMoney(
    lineDiscounts?.full ?? lineDiscounts?.discount ?? lineDiscounts?.amount,
  );
  if (discountFull != null && discountFull > 0 && unitSale != null) {
    const originalDec = new Decimal(unitSale).plus(discountFull).mul(q);
    if (originalDec.gt(saleGrossDec)) return originalDec;
  }

  const discountAmt = resolveLinePriceDiscountAmountBrl(item, order, line, qty);
  if (discountAmt != null && discountAmt > 0) {
    const originalDec = saleGrossDec.plus(discountAmt);
    if (originalDec.gt(saleGrossDec)) return originalDec;
  }

  if (unitSale != null && grossPrice != null && grossPrice > unitSale * q + 0.01) {
    return new Decimal(grossPrice);
  }

  return null;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} line
 * @param {Decimal} originalDec
 * @param {Decimal} saleGrossDec
 * @param {number} qty
 */
function resolvePromotionMetaFromOrderDiscounts(item, order, line, originalDec, saleGrossDec, qty) {
  const snapshot = resolveOrderDiscountsSnapshot(order);
  if (snapshot == null) return { name: null, percentFromApi: null };

  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;
  const orderLineCount = Array.isArray(orderRaw?.order_items) ? orderRaw.order_items.length : 1;

  const externalOrderItemId =
    item.external_order_item_id != null ? String(item.external_order_item_id).trim() : null;
  const externalListingId = item.external_listing_id != null ? String(item.external_listing_id).trim() : null;

  const matchKeys = collectSaleDiscountLineMatchKeys(line, externalOrderItemId, externalListingId);
  const gapNum = originalDec.minus(saleGrossDec).toNumber();

  const details = flattenSaleDiscountDetails(snapshot);
  /** @type {{ name: string | null; amount: number; percentFromApi: string | null } | null} */
  let best = null;

  for (const d of details) {
    const type = String(d.type ?? "").trim().toLowerCase();
    if (type === "coupon" || type === "cashback") continue;

    const supplier =
      d.supplier && typeof d.supplier === "object" ? /** @type {Record<string, unknown>} */ (d.supplier) : {};
    const funding = String(supplier.funding_mode ?? d.funding_mode ?? "").trim().toLowerCase();

    const discountItems = Array.isArray(d.items) ? d.items : [];
    let amountForLine = 0;

    if (discountItems.length > 0) {
      for (const rawItem of discountItems) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const it = /** @type {Record<string, unknown>} */ (rawItem);
        if (!saleDiscountItemMatchesLine(it, matchKeys, orderLineCount)) continue;

        const amounts =
          it.amounts && typeof it.amounts === "object" ? /** @type {Record<string, unknown>} */ (it.amounts) : {};
        const amt = parseMlMoney(amounts.total ?? amounts.seller ?? it.amount ?? d.amount);
        if (amt != null && amt > 0) amountForLine += amt;
      }
    } else {
      const amt = parseMlMoney(d.amount ?? d.value ?? d.coupon_amount ?? d.total);
      if (amt != null && amt > 0) amountForLine = amt;
    }

    if (amountForLine <= 0) continue;

    const matchesGap =
      Math.abs(amountForLine - gapNum) <= 0.08 ||
      (funding === "sale_fee" && isSaleItemPriceGapMislabeledAsSaleFee(amountForLine, line, qty));

    if (!matchesGap) continue;

    const name = humanizeDiscountDetailName(d);
    const pctApi = parseMlMoney(
      d.applied_percentage ??
        d.percentage ??
        d.percent ??
        supplier.applied_percentage ??
        supplier.percentage,
    );
    const percentFromApi =
      pctApi != null && pctApi > 0 && pctApi <= 100
        ? new Decimal(pctApi).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
        : null;

    if (!best || amountForLine >= best.amount) {
      best = { name, amount: amountForLine, percentFromApi };
    }
  }

  if (best) {
    return { name: best.name, percentFromApi: best.percentFromApi };
  }

  const discountFin = resolveMercadoLivreDiscountsFinancials(
    snapshot,
    externalOrderItemId,
    line,
    orderLineCount,
  );
  if (discountFin.sale_fee_subsidy_brl != null) {
    const subsidy = parseMlMoney(discountFin.sale_fee_subsidy_brl);
    if (subsidy != null && Math.abs(subsidy - gapNum) <= 0.08) {
      return { name: "Desconto por porcentagem", percentFromApi: null };
    }
  }

  return { name: null, percentFromApi: null };
}

/**
 * Promoção aplicada nesta venda (não lista promoções do anúncio).
 *
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 */
export function resolveSaleAppliedPromotion(item, order) {
  const lineRaw = resolveEffectiveMercadoLivreSaleLine(item, order);
  const line = mergeOrderLinePricingFields(item, order, lineRaw);
  const qty = resolveSaleQuantity(item, line);
  const { gross: saleGrossDec } = resolveSaleGrossBrl(item, line);

  if (!saleGrossDec || saleGrossDec.lte(0)) return null;

  const originalDec = resolveOriginalProductPriceDec(line, qty, saleGrossDec, item, order);
  if (!originalDec || !originalDec.gt(saleGrossDec)) return null;

  const promoMeta = resolvePromotionMetaFromOrderDiscounts(item, order, line, originalDec, saleGrossDec, qty);
  const promotionName =
    promoMeta.name != null && String(promoMeta.name).trim() !== ""
      ? String(promoMeta.name).trim()
      : "Promoção";

  const promotionDiscountPercent =
    promoMeta.percentFromApi != null
      ? promoMeta.percentFromApi
      : deriveSaleDiscountPercentString(originalDec, saleGrossDec);

  return {
    original_product_price_brl: moneyDecimal(originalDec),
    promotion_name: promotionName,
    promotion_discount_percent: promotionDiscountPercent,
    has_applied_promotion: true,
  };
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function buildSaleDetailMarketplaceRevenue(item, order, listing = null) {
  const marketplaceRevenue = resolveSaleMarketplaceRevenue(item, order, listing);
  const appliedSalePromotion = resolveSaleAppliedPromotion(item, order);

  return {
    marketplace_revenue: {
      ...marketplaceRevenue,
      applied_sale_promotion: appliedSalePromotion,
    },
    applied_sale_promotion: appliedSalePromotion,
    marketplace_fee: marketplaceRevenue.marketplace_fee ?? null,
    gross_amount: marketplaceRevenue.gross_sale_amount_brl,
    sale_price: marketplaceRevenue.gross_sale_amount_brl,
    marketplace_fee_amount: marketplaceRevenue.marketplace_fee_amount_brl,
    commission: marketplaceRevenue.marketplace_fee_amount_brl,
    marketplace_fee_net_amount_brl: marketplaceRevenue.marketplace_fee_net_amount_brl ?? null,
    marketplace_fee_percent: marketplaceRevenue.marketplace_fee_percent,
    listing_type_label: marketplaceRevenue.listing_type_label,
    marketplace_fee_tier_label:
      marketplaceRevenue.marketplace_fee?.listing_type_label ?? marketplaceRevenue.listing_type_label,
    shipping_cost_amount: marketplaceRevenue.shipping_amount_brl,
    shipping_cost: marketplaceRevenue.shipping_amount_brl,
    shipping_bonus_brl: marketplaceRevenue.shipping_bonus_brl ?? null,
    positive_adjustments_brl: marketplaceRevenue.positive_adjustments_brl,
    marketplace_rebate: marketplaceRevenue.marketplace_rebate ?? null,
    net_received_amount: marketplaceRevenue.net_received_amount_brl,
    net_received: marketplaceRevenue.net_received_amount_brl,
  };
}
