/**
 * Bloco general do GET /api/sales/detail — labels operacionais (ML).
 */

import { fetchMercadoLivreShipmentById } from "../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { findMercadoLivreOrderLine } from "../../handlers/sales/_vendasSalesRows.js";
import { resolveMercadoLivreShipmentIdFromOrder } from "../../services/marketplace/mercadoLivreSaleFinancialEnrichment.js";
import {
  buildSaleTypeDisplay,
  resolveSaleChannelKind,
} from "./mercadoLivreSaleTypeDisplay.js";

const BRAZIL_TZ = "America/Sao_Paulo";

const PT_MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** @param {unknown} v */
function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** @param {unknown} v */
function asObj(v) {
  return v && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : null;
}

/**
 * Snapshot do GET /shipments/:id — enrichment persiste em _s7_financial.shipment_snapshot (pedido)
 * e opcionalmente em _s7_shipment_snapshot (item).
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Record<string, unknown> | null | undefined} [itemRaw]
 */
function resolveShipmentSnapshot(orderRaw, itemRaw = null) {
  const fromRoot = asObj(orderRaw?._s7_shipment_snapshot);
  if (fromRoot) return fromRoot;

  const fin = asObj(orderRaw?._s7_financial);
  const fromFin = asObj(fin?.shipment_snapshot);
  if (fromFin) return fromFin;

  const fromItem = asObj(itemRaw?._s7_shipment_snapshot);
  if (fromItem) return fromItem;

  return null;
}

/** @param {Date | string} value */
function ymdInBrazil(value) {
  const dt = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(dt.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: BRAZIL_TZ }).format(dt);
}

/** @param {string} ymd @param {number} days */
function addDaysToYmd(ymd, days) {
  const parts = ymd.split("-").map(Number);
  if (parts.length !== 3) return null;
  const anchor = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days, 12));
  return ymdInBrazil(anchor);
}

/** @param {string | null | undefined} externalOrderId */
export function formatMlSaleNumberDisplay(externalOrderId) {
  const id = safeStr(externalOrderId);
  if (!id) return null;
  if (id.startsWith("#")) return id;
  if (/^\d{10,}$/.test(id)) return `#${id}`;
  return id;
}

/** @type {Set<string>} */
const IN_TRANSIT_STATUSES = new Set(["shipped", "in_transit", "out_for_delivery"]);

/** @type {Set<string>} */
const IN_TRANSIT_SUBSTATUSES = new Set([
  "dropped_off",
  "picked_up",
  "picked up",
  "authorized_by_carrier",
  "in_hub",
  "on_route",
  "on_the_way",
  "in_transit",
  "shipped",
]);

/**
 * @param {Record<string, unknown> | null | undefined} shipment
 */
function shipmentIsOnTheWay(shipment) {
  if (!shipment) return false;
  const status = safeStr(shipment.status)?.toLowerCase();
  const substatus = safeStr(shipment.substatus)?.toLowerCase();
  if (status && IN_TRANSIT_STATUSES.has(status)) return true;
  if (status === "ready_to_ship" && substatus && IN_TRANSIT_SUBSTATUSES.has(substatus)) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} shipment
 * @param {Record<string, unknown> | null | undefined} orderRaw
 */
function pickShipByDeadlineIso(shipment, orderRaw) {
  const opt = asObj(shipment?.shipping_option);
  const edt = asObj(opt?.estimated_delivery_time);
  const fromOpt = safeStr(edt?.pay_before);
  if (fromOpt) return fromOpt;

  const lead = asObj(shipment?.lead_time) ?? asObj(orderRaw?.lead_time);
  const fromLead = safeStr(asObj(lead?.estimated_delivery_time)?.pay_before);
  if (fromLead) return fromLead;

  return safeStr(asObj(opt?.buffering)?.date) ?? safeStr(asObj(lead?.buffering)?.date);
}

/**
 * @param {string} isoDate
 */
function formatShipByDeadlineLabel(isoDate) {
  const payYmd = ymdInBrazil(isoDate);
  if (!payYmd) return null;

  const todayYmd = ymdInBrazil(new Date());
  const tomorrowYmd = todayYmd ? addDaysToYmd(todayYmd, 1) : null;
  if (tomorrowYmd && payYmd === tomorrowYmd) return "Para enviar amanhã";

  const parts = payYmd.split("-").map(Number);
  if (parts.length !== 3) return null;
  const day = parts[2];
  const month = PT_MONTHS[parts[1] - 1];
  if (!month) return null;
  return `Para enviar no dia ${day} de ${month}`;
}

/**
 * @param {Record<string, unknown> | null | undefined} shipment
 * @param {Record<string, unknown> | null | undefined} orderRaw
 */
function resolveStatusFromShipment(shipment, orderRaw) {
  if (!shipment) return null;

  const detail = asObj(shipment.status_detail);
  const detailDesc = safeStr(detail?.description);
  if (detailDesc) return detailDesc;

  const status = safeStr(shipment.status)?.toLowerCase();
  const substatus = safeStr(shipment.substatus)?.toLowerCase();

  if (status === "cancelled" || substatus === "cancelled") return "Venda cancelada";
  if (status === "delivered" || substatus === "delivered") return "Entregue";

  if (shipmentIsOnTheWay(shipment)) return "A caminho";

  const deadlineIso = pickShipByDeadlineIso(shipment, orderRaw);
  if (
    deadlineIso &&
    (status === "pending" ||
      status === "ready_to_ship" ||
      substatus === "buffered" ||
      substatus === "shipment_paid" ||
      substatus === "ready_to_print" ||
      substatus === "waiting_for_carrier_authorization")
  ) {
    const byDate = formatShipByDeadlineLabel(deadlineIso);
    if (byDate) return byDate;
  }

  if (status === "ready_to_ship") return "Pronta para envio";
  if (status === "pending") return "Em preparação";

  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {{ order_status?: string | null; order_substatus?: string | null }} [meta]
 * @param {Record<string, unknown> | null | undefined} [itemRaw]
 */
export function resolveSaleOperationalStatusLabel(orderRaw, meta = {}, itemRaw = null) {
  const orderStatus = safeStr(orderRaw?.status) ?? safeStr(meta.order_status);
  const shipping = asObj(orderRaw?.shipping);
  const shipStatus = safeStr(shipping?.status)?.toLowerCase();

  // Estados do pedido/envio prevalecem sobre heurísticas de snapshot desatualizado.
  if (orderStatus === "cancelled") return "Venda cancelada";
  if (orderStatus === "delivered" || shipStatus === "delivered") return "Entregue";
  if (shipStatus && IN_TRANSIT_STATUSES.has(shipStatus)) return "A caminho";

  const statusDetail = asObj(orderRaw?.status_detail);
  const detailDescription = safeStr(statusDetail?.description);
  if (detailDescription) return detailDescription;

  const shipment = resolveShipmentSnapshot(orderRaw, itemRaw);

  const fromShipment = resolveStatusFromShipment(shipment, orderRaw);
  if (fromShipment) return fromShipment;

  if (orderStatus === "paid" && shipment) {
    const retry = resolveStatusFromShipment(shipment, orderRaw);
    if (retry) return retry;
  }

  if (orderStatus === "paid") {
    const shipmentId =
      safeStr(shipping?.id) ?? safeStr(asObj(orderRaw?._s7_delivery)?.shipment_id);
    if (shipmentId) return "Em preparação";
  }

  return orderStatus ? orderStatus.replace(/_/g, " ") : null;
}

/**
 * @param {string | null | undefined} label
 * @returns {"success" | "warning" | "danger" | "neutral"}
 */
export function resolveSaleStatusTone(label) {
  const text = safeStr(label)?.toLowerCase();
  if (!text) return "neutral";
  if (text.includes("cancelad")) return "danger";
  if (text === "a caminho" || text.includes("a caminho") || text === "entregue" || text.startsWith("entregue")) {
    return "success";
  }
  if (text.startsWith("para enviar")) return "warning";
  return "neutral";
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 */
function resolveReceiverAddress(orderRaw, itemRaw = null) {
  if (!orderRaw) return null;

  const shipment = resolveShipmentSnapshot(orderRaw, itemRaw);
  const fromShipment = asObj(shipment?.receiver_address);
  if (fromShipment) return fromShipment;

  const shipping = asObj(orderRaw.shipping);
  const fromShipping = asObj(shipping?.receiver_address);
  if (fromShipping) return fromShipping;

  const destination = asObj(shipment?.destination);
  return asObj(destination?.shipping_address) ?? null;
}

/**
 * @param {Record<string, unknown> | null | undefined} addr
 */
function formatStreetLine(addr) {
  if (!addr) return null;
  const line = safeStr(addr.address_line);
  if (line) return line;
  const street = safeStr(addr.street_name);
  const number = safeStr(addr.street_number);
  if (street && number) return `${street} ${number}`;
  return street ?? number ?? null;
}

/**
 * @param {Record<string, unknown> | null | undefined} addr
 */
function formatCepLocationLine(addr) {
  if (!addr) return null;
  const zip = safeStr(addr.zip_code);
  const neighborhood =
    safeStr(asObj(addr.neighborhood)?.name) ??
    (typeof addr.neighborhood === "string" ? safeStr(addr.neighborhood) : null);
  const city =
    safeStr(asObj(addr.city)?.name) ??
    safeStr(addr.city_name) ??
    (typeof addr.city === "string" ? safeStr(addr.city) : null);
  const state =
    safeStr(asObj(addr.state)?.name) ??
    safeStr(addr.state_name) ??
    safeStr(asObj(addr.state)?.id)?.replace(/^BR-/i, "");

  const locationParts = [neighborhood, city, state].filter(Boolean);
  const location = locationParts.join(", ");
  if (zip && location) return `CEP ${zip} - ${location}`;
  if (zip) return `CEP ${zip}`;
  return location || null;
}

/**
 * @param {Record<string, unknown> | null | undefined} addr
 * @param {Record<string, unknown> | null | undefined} orderRaw
 */
function formatReceiverNameLine(addr, orderRaw) {
  const receiverName = safeStr(addr?.receiver_name) ?? safeStr(addr?.receiver);
  if (receiverName) return `Quem recebe: ${receiverName}`;

  const buyer = asObj(orderRaw?.buyer);
  const fn = safeStr(buyer?.first_name);
  const ln = safeStr(buyer?.last_name);
  const full = safeStr(buyer?.full_name) ?? (fn && ln ? `${fn} ${ln}` : fn ?? ln);
  if (full) return `Quem recebe: ${full}`;
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} addr
 */
function formatStateUf(addr) {
  if (!addr) return null;
  const stateId = safeStr(asObj(addr.state)?.id);
  if (stateId && /^BR-/i.test(stateId)) return stateId.replace(/^BR-/i, "");
  const stateName = safeStr(asObj(addr.state)?.name) ?? safeStr(addr.state_name);
  if (!stateName) return null;
  const map = {
    "distrito federal": "DF",
    "minas gerais": "MG",
    "são paulo": "SP",
    "sao paulo": "SP",
    "rio de janeiro": "RJ",
    "paraná": "PR",
    "parana": "PR",
  };
  const key = stateName.toLowerCase();
  return map[key] ?? (stateName.length <= 3 ? stateName.toUpperCase() : null);
}

/**
 * @param {Record<string, unknown> | null | undefined} addr
 */
function formatCepCityStateCompact(addr) {
  if (!addr) return null;
  const zip = safeStr(addr.zip_code);
  const city =
    safeStr(asObj(addr.city)?.name) ??
    safeStr(addr.city_name) ??
    (typeof addr.city === "string" ? safeStr(addr.city) : null);
  const uf = formatStateUf(addr);
  const cityUf = city && uf ? `${city}/${uf}` : city ?? uf ?? null;
  if (zip && cityUf) return `CEP ${zip} • ${cityUf}`;
  if (zip) return `CEP ${zip}`;
  return cityUf;
}

/**
 * @param {Record<string, unknown> | null | undefined} addr
 * @param {Record<string, unknown> | null | undefined} orderRaw
 */
function formatReceiverCompact(addr, orderRaw) {
  const receiverName = safeStr(addr?.receiver_name) ?? safeStr(addr?.receiver);
  if (receiverName) return `Recebedor: ${receiverName}`;

  const buyer = asObj(orderRaw?.buyer);
  const fn = safeStr(buyer?.first_name);
  const ln = safeStr(buyer?.last_name);
  const full = safeStr(buyer?.full_name) ?? (fn && ln ? `${fn} ${ln}` : fn ?? ln);
  if (full) return `Recebedor: ${full}`;
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Record<string, unknown> | null | undefined} itemRaw
 */
export function buildSaleDetailShippingDisplayCompact(orderRaw, itemRaw = null) {
  if (!orderRaw) return null;

  const addr = resolveReceiverAddress(orderRaw, itemRaw);
  const street_line = formatStreetLine(addr);
  const cep_city_state = formatCepCityStateCompact(addr);
  const receiver_label = formatReceiverCompact(addr, orderRaw);

  if (!street_line && !cep_city_state && !receiver_label) return null;

  return {
    title: "Dados do envio",
    street_line,
    cep_city_state,
    receiver_label,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Record<string, unknown> | null | undefined} itemRaw
 * @param {Record<string, unknown> | null | undefined} lineRaw
 */
function resolveSaleOriginLabel(orderRaw, itemRaw, lineRaw) {
  const kind = resolveSaleChannelKind(orderRaw, itemRaw, lineRaw);
  if (kind === "affiliate") return "Venda por afiliado";
  if (kind === "advertising") return "Venda por publicidade";
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Record<string, unknown> | null | undefined} itemRaw
 * @param {Record<string, unknown> | null | undefined} shipment
 * @returns {{ type: "full" | "flex" | "standard"; label: string }}
 */
function buildFulfillmentDisplay(orderRaw, itemRaw, shipment) {
  const s7 = asObj(orderRaw?._s7_delivery);
  const shipping = asObj(orderRaw?.shipping);
  const logistic = (
    safeStr(shipment?.logistic_type) ??
    safeStr(s7?.logistics_type) ??
    safeStr(shipping?.logistic_type) ??
    safeStr(itemRaw?.logistic_type)
  )?.toLowerCase();

  if (logistic === "fulfillment") {
    return { type: "full", label: "FULL" };
  }
  if (logistic === "self_service" || logistic === "flex") {
    return { type: "flex", label: "FLEX" };
  }
  return { type: "standard", label: "Padrão" };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown> | null | undefined} order
 */
/**
 * Atualiza snapshot do envio para exibição operacional (não altera cálculo financeiro).
 * @param {Record<string, unknown> | null | undefined} order
 * @param {string} accessToken
 * @param {string | null | undefined} marketplaceAccountId
 */
export async function attachFreshMercadoLivreShipmentSnapshot(order, accessToken, marketplaceAccountId) {
  if (!order || typeof order !== "object" || !accessToken) return order;

  const orderRaw =
    order.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (order.raw_json) })
      : null;
  if (!orderRaw) return order;

  const shipmentId = resolveMercadoLivreShipmentIdFromOrder(orderRaw);
  if (!shipmentId) return order;

  try {
    const snap = await fetchMercadoLivreShipmentById(accessToken, shipmentId, {
      marketplaceAccountId: marketplaceAccountId ?? null,
    });
    const fin =
      orderRaw._s7_financial && typeof orderRaw._s7_financial === "object"
        ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (orderRaw._s7_financial) })
        : {};

    return {
      ...order,
      raw_json: {
        ...orderRaw,
        _s7_shipment_snapshot: snap,
        _s7_financial: {
          ...fin,
          shipment_snapshot: snap,
        },
      },
    };
  } catch {
    return order;
  }
}

export function buildSaleDetailGeneralBlock(row, order, item = null) {
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  const itemRaw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;

  const saleNumberRaw =
    row.sale_display_code != null
      ? String(row.sale_display_code).trim()
      : row.external_order_id != null
        ? String(row.external_order_id).trim()
        : order?.external_order_id != null
          ? String(order.external_order_id).trim()
          : "";

  const sale_status_label = resolveSaleOperationalStatusLabel(
    orderRaw,
    {
      order_status: row.order_status ?? order?.order_status ?? null,
      order_substatus: order?.order_substatus ?? null,
    },
    itemRaw,
  );

  const extListing =
    row.external_listing_id != null
      ? String(row.external_listing_id).trim()
      : row.listing_id_display != null
        ? String(row.listing_id_display).trim()
        : itemRaw?.external_listing_id != null
          ? String(itemRaw.external_listing_id).trim()
          : "";
  const extItem =
    row.external_order_item_id != null
      ? String(row.external_order_item_id).trim()
      : itemRaw?.external_order_item_id != null
        ? String(itemRaw.external_order_item_id).trim()
        : "";
  const orderLine = findMercadoLivreOrderLine(orderRaw, extItem || null, extListing || null);
  const shipment = resolveShipmentSnapshot(orderRaw, itemRaw);
  const saleTypeDisplay = buildSaleTypeDisplay(orderRaw, itemRaw, orderLine);

  return {
    sale_date: row.sale_date ?? null,
    sale_number: saleNumberRaw || null,
    sale_number_display: formatMlSaleNumberDisplay(saleNumberRaw),
    external_order_id: saleNumberRaw || null,
    marketplace: row.marketplace ?? null,
    marketplace_label: row.marketplace_label ?? null,
    buyer_display_name: row.buyer_display_name ?? null,
    account_alias: row.account_alias ?? row.ml_account_alias ?? null,
    order_status: row.order_status ?? order?.order_status ?? null,
    sale_status_label,
    sale_status_tone: resolveSaleStatusTone(sale_status_label),
    quantity: row.quantity ?? null,
    sku_display: row.sku_display ?? null,
    listing_id_display: row.listing_id_display ?? null,
    sale_origin_label: resolveSaleOriginLabel(orderRaw, itemRaw, orderLine),
    sale_type_display: saleTypeDisplay,
    sale_type_label: saleTypeDisplay.label,
    fulfillment_display: buildFulfillmentDisplay(orderRaw, itemRaw, shipment),
    shipping_display_compact: buildSaleDetailShippingDisplayCompact(orderRaw, itemRaw),
  };
}
