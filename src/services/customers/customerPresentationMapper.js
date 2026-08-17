// =============================================================================
// Clientes 360 — projeção de raw_json → contrato de leitura (sem write)
// =============================================================================

import { extractBuyerForGlobalSync } from "./s7GlobalCustomerSync.js";

function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * @param {unknown} orderRaw
 */
function orderRawObj(orderRaw) {
  return orderRaw && typeof orderRaw === "object" ? /** @type {Record<string, unknown>} */ (orderRaw) : {};
}

/**
 * @param {Record<string, unknown>} buyer
 * @param {Record<string, unknown>} raw
 */
function pickDocument(buyer, raw) {
  const pick = extractBuyerForGlobalSync(raw);
  if (pick.document_normalized) return pick.document_normalized;
  const idObj =
    buyer.billing_info && typeof buyer.billing_info === "object"
      ? buyer.billing_info.identification
      : buyer.identification;
  if (idObj && typeof idObj === "object") {
    const num = safeStr(idObj.number);
    if (num) return num;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} raw
 */
function pickAddress(raw) {
  const shipping =
    raw.shipping && typeof raw.shipping === "object" ? /** @type {Record<string, unknown>} */ (raw.shipping) : {};
  const receiver =
    shipping.receiver_address && typeof shipping.receiver_address === "object"
      ? /** @type {Record<string, unknown>} */ (shipping.receiver_address)
      : null;
  const shipment =
    raw.shipment_snapshot && typeof raw.shipment_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (raw.shipment_snapshot)
      : null;
  const shipAddr =
    shipment?.receiver_address && typeof shipment.receiver_address === "object"
      ? /** @type {Record<string, unknown>} */ (shipment.receiver_address)
      : null;
  const addr = receiver ?? shipAddr ?? null;
  if (!addr) return null;

  const street = safeStr(addr.street_name ?? addr.address_line);
  const number = safeStr(addr.street_number);
  const city = safeStr(addr.city?.name ?? addr.city);
  const state = safeStr(addr.state?.name ?? addr.state);
  const zip = safeStr(addr.zip_code);
  const neighborhood = safeStr(addr.neighborhood?.name ?? addr.neighborhood);
  const complement = safeStr(addr.comment ?? addr.complement);
  const country = safeStr(addr.country?.name ?? addr.country);

  const parts = [street, number, neighborhood, city, state].filter(Boolean);
  return {
    address_raw: parts.length ? parts.join(", ") : null,
    street,
    number,
    complement,
    neighborhood,
    city,
    state,
    zip_code: zip,
    country,
  };
}

/**
 * @param {Record<string, unknown>} buyer
 * @param {Record<string, unknown>} raw
 */
function pickBilling(buyer, raw) {
  const bi =
    buyer.billing_info && typeof buyer.billing_info === "object"
      ? /** @type {Record<string, unknown>} */ (buyer.billing_info)
      : {};
  const idObj = bi.identification && typeof bi.identification === "object" ? bi.identification : {};
  const addr = bi.address && typeof bi.address === "object" ? bi.address : {};
  const docNum = safeStr(idObj.number);
  const addrParts = [
    safeStr(addr.street_name),
    safeStr(addr.street_number),
    safeStr(addr.city_name ?? addr.city),
    safeStr(addr.state_name ?? addr.state),
  ].filter(Boolean);

  return {
    nfe_em_anexo: safeStr(raw.invoice_emitted ?? raw.has_invoice) != null ? String(raw.invoice_emitted ?? raw.has_invoice) : null,
    dados_pessoais_ou_empresa: safeStr(bi.business_name ?? buyer.full_name),
    tipo_numero_documento: safeStr(idObj.type),
    document_number: docNum,
    faturamento_endereco: addrParts.length ? addrParts.join(", ") : null,
    tipo_contribuinte: safeStr(bi.tax_type),
    inscricao_estadual: safeStr(bi.state_registration),
  };
}

/**
 * @param {Record<string, unknown>} row — marketplace_customers
 */
export function extractPresentationFromCustomerRow(row) {
  const raw = orderRawObj(row.raw_json);
  const buyer = raw.buyer && typeof raw.buyer === "object" ? /** @type {Record<string, unknown>} */ (raw.buyer) : {};
  const document = pickDocument(buyer, raw);
  const address = pickAddress(raw);
  const billing = pickBilling(buyer, raw);

  const phoneDisplay = safeStr(row.phone);
  const whatsappDisplay =
    safeStr(row.whatsapp) ??
    (row.phone_area_code && row.phone_number
      ? `${row.phone_area_code}${row.phone_number}`
      : phoneDisplay);

  const isBusiness =
    buyer.billing_info && typeof buyer.billing_info === "object"
      ? Boolean(buyer.billing_info.is_business ?? buyer.billing_info.business_name)
      : null;

  return {
    document,
    address,
    billing,
    city: address?.city ?? null,
    state: address?.state ?? null,
    whatsapp: whatsappDisplay,
    is_business: isBusiness,
    cpf: document && document.length === 11 ? document : null,
    cnpj: document && document.length === 14 ? document : null,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReturnType<import("./customerOrderAggregateService.js").emptyAggregate>} agg
 */
export function mapCustomerListRow(row, agg) {
  const pres = extractPresentationFromCustomerRow(row);
  const totalOrders = agg?.total_orders ?? 0;
  const totalSpent = agg?.total_spent ?? 0;

  return {
    id: String(row.id),
    name: safeStr(row.name),
    document: pres.document,
    email: safeStr(row.email),
    email_is_masked: Boolean(row.email_is_masked),
    phone: safeStr(row.phone),
    whatsapp: pres.whatsapp,
    whatsapp_e164: safeStr(row.whatsapp_e164),
    city: pres.city,
    state: pres.state,
    total_orders: totalOrders,
    total_spent_brl: formatBrl(totalSpent),
    last_purchase_at: agg?.last_purchase_at ?? null,
    customer_status: null,
    marketplace: safeStr(row.marketplace),
    marketplace_account_id: row.marketplace_account_id != null ? String(row.marketplace_account_id) : null,
    seller_company_id: row.seller_company_id != null ? String(row.seller_company_id) : null,
    external_customer_id: safeStr(row.external_customer_id),
    _agg: agg,
    _pres: pres,
  };
}

/** @param {number} n */
function formatBrl(n) {
  if (!Number.isFinite(n)) return "0.00";
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * @param {Record<string, unknown>} order
 */
export function mapCustomerOrderRow(order) {
  const raw = orderRawObj(order.raw_json);
  const paid = order.total_amount ?? raw.paid_amount ?? raw.total_amount;
  return {
    id: String(order.id),
    external_order_id: safeStr(order.external_order_id),
    external_pack_id: safeStr(raw.pack_id ?? raw.packId),
    order_date: order.date_created_marketplace != null ? String(order.date_created_marketplace) : null,
    order_status: safeStr(order.order_status),
    gross_amount_brl: formatBrl(Number(paid)),
    paid_amount_brl: formatBrl(Number(paid)),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReturnType<import("./customerOrderAggregateService.js").emptyAggregate>} agg
 */
export function mapCustomerDetailCustomer(row) {
  const pres = extractPresentationFromCustomerRow(row);
  return {
    id: String(row.id),
    name: safeStr(row.name),
    document_number: pres.document,
    cpf: pres.cpf,
    cnpj: pres.cnpj,
    email: safeStr(row.email),
    phone: safeStr(row.phone),
    whatsapp: pres.whatsapp,
    whatsapp_e164: safeStr(row.whatsapp_e164),
    email_is_masked: Boolean(row.email_is_masked),
    is_business: pres.is_business,
    billing: pres.billing,
    address: pres.address,
    marketplace: safeStr(row.marketplace),
    marketplace_account_id: row.marketplace_account_id != null ? String(row.marketplace_account_id) : null,
    seller_company_id: row.seller_company_id != null ? String(row.seller_company_id) : null,
    external_customer_id: safeStr(row.external_customer_id),
  };
}
