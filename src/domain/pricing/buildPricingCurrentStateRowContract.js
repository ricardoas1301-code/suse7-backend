// ======================================================================
// Contrato read-model — estado atual/projetado unitário da Precificação.
// Separado de métricas históricas (sales_order_items, executive summary).
// Usado pela lista GET /api/ml/listings → pricing_current_state.
// ======================================================================

import Decimal from "decimal.js";

const ROUND = Decimal.ROUND_HALF_UP;

/**
 * @param {unknown} v
 * @returns {Decimal | null}
 */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).trim().replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * @param {Decimal | null | undefined} d
 * @returns {string | null}
 */
function decStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * @param {Record<string, unknown>} gridRow
 */
function resolveCurrentUnitPrice(gridRow) {
  const promoActive = gridRow.promotion_active === true;
  const promoDec = toDec(gridRow.promotion_sale_price_brl ?? gridRow.promotional_price_brl);
  const effectiveDec = toDec(gridRow.effective_sale_price_brl);
  const listingDec = toDec(gridRow.listing_sale_price_brl ?? gridRow.listing_price_brl);

  let currentDec = null;
  let currentPriceSource = "unavailable";

  if (promoActive && promoDec != null && promoDec.gt(0)) {
    currentDec = promoDec;
    currentPriceSource = "promotion_sale_price_brl";
  } else if (effectiveDec != null && effectiveDec.gt(0)) {
    currentDec = effectiveDec;
    currentPriceSource = "effective_sale_price_brl";
  } else if (listingDec != null && listingDec.gt(0)) {
    currentDec = listingDec;
    currentPriceSource = "listing_sale_price_brl";
  }

  const regularDec =
    promoActive && listingDec != null && promoDec != null && listingDec.gt(promoDec) ? listingDec : null;

  return { currentDec, regularDec, currentPriceSource };
}

/**
 * Estado financeiro unitário atual/projetado — NUNCA usa contribution_profit_brl,
 * net_profit_brl lifetime, you_receive_brl histórico ou sales_order_items.
 *
 * @param {Record<string, unknown>} gridRow — linha da grid antes do overlay histórico executive.
 * @returns {Record<string, unknown>}
 */
export function buildPricingCurrentStateRowContract(gridRow) {
  const row = gridRow && typeof gridRow === "object" ? gridRow : {};
  const pricingContext =
    row.pricing_context != null && typeof row.pricing_context === "object"
      ? /** @type {Record<string, unknown>} */ (row.pricing_context)
      : null;
  const result =
    pricingContext?.result != null && typeof pricingContext.result === "object"
      ? /** @type {Record<string, unknown>} */ (pricingContext.result)
      : null;
  const internalCosts =
    pricingContext?.internal_costs != null && typeof pricingContext.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ (pricingContext.internal_costs)
      : null;
  const productHealth =
    pricingContext?.product_health != null && typeof pricingContext.product_health === "object"
      ? /** @type {Record<string, unknown>} */ (pricingContext.product_health)
      : null;
  const netProceeds =
    row.net_proceeds != null && typeof row.net_proceeds === "object"
      ? /** @type {Record<string, unknown>} */ (row.net_proceeds)
      : null;

  /** @type {string[]} */
  const missingDataFlags = [];

  const price = resolveCurrentUnitPrice(row);
  if (price.currentDec == null || !price.currentDec.gt(0)) {
    missingDataFlags.push("current_price_unavailable");
  }

  const rawPriceReceived =
    row.promotion_active === true
      ? (row.promotion_sale_price_brl ?? row.promotional_price_brl ?? row.effective_sale_price_brl ?? row.listing_sale_price_brl ?? row.listing_price_brl ?? null)
      : (row.effective_sale_price_brl ?? row.listing_sale_price_brl ?? row.listing_price_brl ?? null);
  const rawProductCostReceived = internalCosts?.product_cost_brl ?? null;
  const rawCommissionReceived = row.commission_amount_brl ?? netProceeds?.sale_fee_amount ?? null;
  const rawShippingReceived =
    row.shipping_cost_brl ?? row.shipping_cost_amount_brl ?? netProceeds?.shipping_cost_amount ?? null;

  const commissionDec =
    toDec(row.commission_amount_brl) ?? toDec(netProceeds?.sale_fee_amount);
  const commissionPctRaw = row.commission_percent ?? netProceeds?.sale_fee_percent ?? null;
  let feeSource = null;
  if (commissionDec != null) {
    feeSource = row.commission_amount_brl != null ? "commission_amount_brl" : "net_proceeds.sale_fee_amount";
  } else {
    missingDataFlags.push("commission_unavailable");
  }

  const freightDec =
    toDec(row.shipping_cost_brl ?? row.shipping_cost_amount_brl) ??
    toDec(netProceeds?.shipping_cost_amount);
  let freightSource = null;
  if (freightDec != null) {
    freightSource =
      row.shipping_cost_brl != null || row.shipping_cost_amount_brl != null
        ? "shipping_cost_brl"
        : "net_proceeds.shipping_cost_amount";
  } else {
    missingDataFlags.push("freight_unavailable");
  }

  /** Repasse unitário — proibido you_receive_brl / net_received_brl histórico. */
  let payoutDec = toDec(row.marketplace_payout_amount);
  let payoutSource = payoutDec != null ? "marketplace_payout_amount" : null;

  if (payoutDec == null) {
    payoutDec = toDec(netProceeds?.marketplace_payout_amount_brl ?? netProceeds?.marketplace_payout_amount);
    if (payoutDec != null) payoutSource = "net_proceeds.marketplace_payout_amount";
  }
  if (payoutDec == null) {
    payoutDec = toDec(netProceeds?.net_proceeds_amount);
    if (payoutDec != null) payoutSource = "net_proceeds.net_proceeds_amount";
  }
  if (
    payoutDec == null &&
    price.currentDec != null &&
    commissionDec != null &&
    freightDec != null
  ) {
    const derived = price.currentDec.minus(commissionDec).minus(freightDec);
    if (derived.gte(0)) {
      payoutDec = derived.toDecimalPlaces(2, ROUND);
      payoutSource = "derived_gross_minus_commission_minus_freight";
    }
  }
  if (payoutDec == null) missingDataFlags.push("payout_unavailable");

  const taxDec = toDec(internalCosts?.tax_amount_brl);
  const taxPctRaw = internalCosts?.tax_percent_applied ?? null;
  const taxSource = taxDec != null ? "pricing_context.internal_costs.tax_amount_brl" : null;
  if (taxDec == null && productHealth?.has_complete_costs === true) {
    missingDataFlags.push("tax_unavailable");
  }

  const productCostDec = toDec(internalCosts?.product_cost_brl);
  const operationalDec = toDec(internalCosts?.operational_packaging_total_brl);
  const costSource =
    productCostDec != null ? "pricing_context.internal_costs.product_cost_brl" : null;

  const healthStatus =
    productHealth?.product_health_status != null
      ? String(productHealth.product_health_status)
      : null;
  if (healthStatus === "MISSING_PRODUCT") missingDataFlags.push("missing_product");
  if (healthStatus === "INCOMPLETE_PRODUCT") missingDataFlags.push("incomplete_product");

  let profitDec = toDec(result?.profit_brl);
  let marginDec = toDec(result?.margin_pct);
  let profitSource = profitDec != null ? "pricing_context.result.profit_brl" : null;

  if (profitDec == null && payoutDec != null && price.currentDec != null && price.currentDec.gt(0)) {
    const taxAmt = taxDec ?? new Decimal(0);
    const productAmt = productCostDec ?? new Decimal(0);
    const opAmt = operationalDec ?? new Decimal(0);
    profitDec = payoutDec.minus(productAmt).minus(taxAmt).minus(opAmt).toDecimalPlaces(2, ROUND);
    profitSource = "derived_payout_minus_current_costs";
    marginDec = profitDec.div(price.currentDec).times(100).toDecimalPlaces(2, ROUND);
  }

  if (profitDec == null && healthStatus !== "MISSING_PRODUCT") {
    missingDataFlags.push("profit_unavailable");
  }

  return {
    contract_kind: "pricing_current_state_projected_unit",
    money_scale: "BRL_DECIMAL",
    listing_id: row.id ?? row.listing_id ?? null,
    external_listing_id: row.external_listing_id ?? null,
    product_id: row.product_id ?? null,
    sku: row.sku ?? null,
    marketplace: row.marketplace ?? null,
    account_id: row.marketplace_account_id ?? null,
    current_price: decStr2(price.currentDec),
    current_price_brl: decStr2(price.currentDec),
    current_regular_price: decStr2(price.regularDec),
    regular_price_brl: decStr2(price.regularDec),
    promotion_active: row.promotion_active === true,
    current_listing_type: row.listing_type_label ?? null,
    listing_type: row.listing_type_label ?? null,
    projected_payout: decStr2(payoutDec),
    projected_commission: decStr2(commissionDec),
    projected_commission_percent:
      commissionPctRaw != null && String(commissionPctRaw).trim() !== ""
        ? String(commissionPctRaw).trim()
        : null,
    projected_freight: decStr2(freightDec),
    projected_tax: decStr2(taxDec),
    projected_tax_percent:
      taxPctRaw != null && String(taxPctRaw).trim() !== "" ? String(taxPctRaw).trim() : null,
    current_product_cost: decStr2(productCostDec),
    product_cost_brl: decStr2(productCostDec),
    current_operational_cost: decStr2(operationalDec),
    projected_profit_brl: decStr2(profitDec),
    projected_profit_percent: decStr2(marginDec),
    pricing_source_trace: {
      current_price_source: price.currentPriceSource,
      payout_source: payoutSource,
      fee_source: feeSource,
      freight_source: freightSource,
      cost_source: costSource,
      tax_source: taxSource,
      profit_source: profitSource,
      raw_price_received: rawPriceReceived,
      normalized_current_price_brl: decStr2(price.currentDec),
      raw_product_cost_received: rawProductCostReceived,
      normalized_product_cost_brl: decStr2(productCostDec),
      raw_commission_received: rawCommissionReceived,
      normalized_commission_brl: decStr2(commissionDec),
      raw_shipping_received: rawShippingReceived,
      normalized_shipping_brl: decStr2(freightDec),
      normalized_tax_brl: decStr2(taxDec),
      normalized_profit_brl: decStr2(profitDec),
      normalized_profit_percent: decStr2(marginDec),
    },
    missing_data_flags: missingDataFlags,
  };
}

/**
 * Log de auditoria — amostra da lista e cases de homologação.
 * @param {Record<string, unknown>} contract
 */
export function logPricingCurrentStateRowAudit(contract) {
  const externalId =
    contract.external_listing_id != null ? String(contract.external_listing_id).trim() : "";
  const homologCase = externalId === "MLB6415546858" || externalId === "MLB6086602390";
  const auditEnabled =
    homologCase ||
    process.env.S7_PRICING_CURRENT_STATE_AUDIT === "1" ||
    process.env.NODE_ENV !== "production";

  if (!auditEnabled) return;

  const trace =
    contract.pricing_source_trace != null && typeof contract.pricing_source_trace === "object"
      ? /** @type {Record<string, unknown>} */ (contract.pricing_source_trace)
      : {};

  console.info("[S7_PRICING_CURRENT_STATE_ROW]", {
    listing_id: contract.external_listing_id ?? contract.listing_id ?? null,
    sku: contract.sku ?? null,
    raw_price_received: trace.raw_price_received ?? null,
    normalized_current_price_brl: trace.normalized_current_price_brl ?? contract.current_price_brl ?? null,
    raw_product_cost_received: trace.raw_product_cost_received ?? null,
    normalized_product_cost_brl: trace.normalized_product_cost_brl ?? contract.product_cost_brl ?? null,
    raw_commission_received: trace.raw_commission_received ?? null,
    normalized_commission_brl: trace.normalized_commission_brl ?? contract.projected_commission ?? null,
    raw_shipping_received: trace.raw_shipping_received ?? null,
    normalized_shipping_brl: trace.normalized_shipping_brl ?? contract.projected_freight ?? null,
    normalized_tax_brl: trace.normalized_tax_brl ?? contract.projected_tax ?? null,
    normalized_profit_brl: trace.normalized_profit_brl ?? contract.projected_profit_brl ?? null,
    normalized_profit_percent: trace.normalized_profit_percent ?? contract.projected_profit_percent ?? null,
    money_scale: contract.money_scale ?? "BRL_DECIMAL",
    source_contract: contract.contract_kind ?? "pricing_current_state_projected_unit",
    current_price_source: trace.current_price_source ?? null,
    fee_source: trace.fee_source ?? null,
    cost_source: trace.cost_source ?? null,
    tax_source: trace.tax_source ?? null,
    missing_data_flags: contract.missing_data_flags ?? [],
  });
}
