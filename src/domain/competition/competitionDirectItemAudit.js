// ============================================================
// S7 — Concorrência: auditoria direta GET /items/{ITEM_ID}
// Prova definitiva de sold_quantity com token da conta conectada.
// ============================================================

import { competitionSalesAuditEnabled } from "./competitionSalesMlAudit.js";
import { pickSoldQuantityFromMlBody } from "./competitionSalesHintParse.js";

console.info("[S7_COMPETITION_AUDIT_BOOT]", {
  module: "competitionDirectItemAudit",
  at: new Date().toISOString(),
});

const ML_API = "https://api.mercadolibre.com";
const ITEM_ATTRIBUTES_QUERY =
  "id,title,seller_id,sold_quantity,price,permalink,available_quantity,status";

const SALES_RELATED_KEYS = [
  "sold_quantity",
  "quantity_sold",
  "total_sold",
  "sales",
  "available_quantity",
  "initial_quantity",
];

function pickItemSellerId(body) {
  if (!body || typeof body !== "object") return null;
  if (body.seller_id != null && String(body.seller_id).trim() !== "") {
    return String(body.seller_id).trim();
  }
  const seller = body.seller && typeof body.seller === "object" ? body.seller : null;
  if (seller?.id != null && String(seller.id).trim() !== "") return String(seller.id).trim();
  return null;
}

function sanitizeItemRelevantFields(body) {
  if (!body || typeof body !== "object") return null;
  const out = {};
  for (const key of [
    "id",
    "title",
    "seller_id",
    "sold_quantity",
    "price",
    "permalink",
    "available_quantity",
    "status",
    "quantity_sold",
    "total_sold",
    "sales",
    "initial_quantity",
  ]) {
    if (key in body) out[key] = body[key];
  }
  const nestedSeller = pickItemSellerId(body);
  if (nestedSeller) out.seller_id_resolved = nestedSeller;
  return out;
}

function analyzeSoldQuantityField(body) {
  if (!body || typeof body !== "object") {
    return {
      field_present: false,
      sold_quantity_raw: null,
      sold_quantity_positive: false,
      alternative_sales_fields: {},
      diagnosis: "empty_body",
    };
  }
  const fieldPresent = Object.prototype.hasOwnProperty.call(body, "sold_quantity");
  const raw = body.sold_quantity ?? null;
  const positive = pickSoldQuantityFromMlBody(body) != null;
  const alternatives = {};
  for (const key of SALES_RELATED_KEYS) {
    if (key === "sold_quantity") continue;
    if (key in body && body[key] != null && body[key] !== "") {
      alternatives[key] = body[key];
    }
  }
  let diagnosis = "sold_quantity_absent";
  if (fieldPresent && raw === null) diagnosis = "sold_quantity_null";
  else if (fieldPresent && Number(raw) === 0) diagnosis = "sold_quantity_zero";
  else if (fieldPresent && !positive) diagnosis = "sold_quantity_not_positive";
  else if (positive) diagnosis = "sold_quantity_available";

  return {
    field_present: fieldPresent,
    sold_quantity_raw: raw,
    sold_quantity_positive: positive,
    alternative_sales_fields: alternatives,
    diagnosis,
  };
}

/** Evidência objetiva legível: 200/403 + estado do campo sold_quantity. */
function buildSoldQuantityEvidence(httpStatus, analysis, httpOk) {
  if (!httpOk) {
    if (httpStatus === 403) return "http_403_blocked";
    if (httpStatus === 401) return "http_401_unauthorized";
    if (httpStatus === 404) return "http_404_not_found";
    return `http_${httpStatus}_error`;
  }
  if (!analysis) return "http_200_empty_body";
  if (analysis.diagnosis === "sold_quantity_available") return "http_200_sold_quantity_present_positive";
  if (analysis.diagnosis === "sold_quantity_null") return "http_200_sold_quantity_null";
  if (analysis.diagnosis === "sold_quantity_zero") return "http_200_sold_quantity_zero";
  if (analysis.diagnosis === "sold_quantity_absent") return "http_200_sold_quantity_field_absent";
  return `http_200_${analysis.diagnosis}`;
}

function classifyHttpFailure(status, json) {
  if (status === 403) return "permission_or_policy_blocked";
  if (status === 401) return "unauthorized_token";
  if (status === 404) return "item_not_found";
  if (status >= 500) return "ml_server_error";
  const msg = String(json?.message || json?.error || "").toLowerCase();
  if (msg.includes("policy") || msg.includes("unauthorized")) return "permission_or_policy_blocked";
  return "http_error";
}

function logAuditStart(payload) {
  if (!competitionSalesAuditEnabled()) return;
  console.info("[S7_COMPETITION_DIRECT_ITEM_AUDIT_START]", payload);
}

function logDirectItemAudit(payload) {
  if (!competitionSalesAuditEnabled()) return;
  console.info("[S7_COMPETITION_DIRECT_ITEM_AUDIT]", payload);
}

function logAuditEnd(payload) {
  if (!competitionSalesAuditEnabled()) return;
  console.info("[S7_COMPETITION_DIRECT_ITEM_AUDIT_END]", payload);
}

async function fetchItemEndpoint(accessToken, itemId, attributes = null) {
  const id = encodeURIComponent(String(itemId).trim());
  const query = attributes ? `?attributes=${encodeURIComponent(attributes)}` : "";
  const url = `${ML_API}/items/${id}${query}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12000),
  });
  const json = await res.json().catch(() => null);
  return { url, ok: res.ok, status: res.status, json };
}

/**
 * Auditoria direta do item concorrente via GET /items/{id} (+ variação attributes).
 * @param {{
 *   accessToken: string;
 *   item_id: string;
 *   connected_seller_id?: string | null;
 *   own_listing_id?: string | null;
 *   trigger?: string | null;
 * }} opts
 */
export async function runDirectItemSoldQuantityAudit(opts = {}) {
  const itemId = String(opts.item_id || "").trim();
  const accessToken = opts.accessToken ?? null;
  const connectedSellerId =
    opts.connected_seller_id != null ? String(opts.connected_seller_id).trim() : null;
  const ownListingId = opts.own_listing_id != null ? String(opts.own_listing_id).trim() : null;
  const trigger = opts.trigger != null ? String(opts.trigger).trim() : "save_enrich";
  const checkedAt = new Date().toISOString();
  const endpointsChecked = [];

  logAuditStart({
    item_id: itemId || null,
    connected_seller_id: connectedSellerId,
    own_listing_id: ownListingId || null,
    trigger,
    has_access_token: Boolean(accessToken),
    endpoints_planned: [
      `GET /items/${itemId || "{ITEM_ID}"}`,
      `GET /items/${itemId || "{ITEM_ID}"}?attributes=${ITEM_ATTRIBUTES_QUERY}`,
      ownListingId && ownListingId !== itemId ? `GET /items/${ownListingId} (own_listing)` : null,
    ].filter(Boolean),
    at: checkedAt,
  });

  const empty = {
    hit: null,
    resolved: false,
    scenario: null,
    resolution: {
      sales_hint: null,
      sales_hint_source: null,
      sales_hint_confidence: null,
      sales_hint_checked_at: checkedAt,
    },
    endpoints_checked: endpointsChecked,
    diagnosis: null,
  };

  if (!itemId || !accessToken) {
    logDirectItemAudit({
      item_id: itemId || null,
      phase: "skipped",
      error: "missing_item_id_or_token",
      connected_seller_id: connectedSellerId,
    });
    logAuditEnd({
      item_id: itemId || null,
      trigger,
      resolved: false,
      scenario: null,
      sales_hint: null,
      sales_hint_source: null,
      reason: "missing_item_id_or_token",
      at: new Date().toISOString(),
    });
    return empty;
  }

  const full = await fetchItemEndpoint(accessToken, itemId);
  endpointsChecked.push(`GET /items/${itemId}`);
  const fullAnalysis = full.ok ? analyzeSoldQuantityField(full.json) : null;
  const itemSellerId = full.ok ? pickItemSellerId(full.json) : null;
  const isThirdParty =
    connectedSellerId && itemSellerId ? connectedSellerId !== itemSellerId : itemSellerId != null;
  const fullEvidence = buildSoldQuantityEvidence(full.status, fullAnalysis, full.ok);

  logDirectItemAudit({
    phase: "full_item",
    item_id: itemId,
    endpoint: `GET /items/${itemId}`,
    url: full.url,
    http_status: full.status,
    http_ok: full.ok,
    sold_quantity_evidence: fullEvidence,
    seller_id: itemSellerId,
    item_seller_id: itemSellerId,
    connected_seller_id: connectedSellerId,
    is_third_party_listing: isThirdParty,
    has_sold_quantity_field: fullAnalysis?.field_present ?? false,
    sold_quantity_raw: fullAnalysis?.sold_quantity_raw ?? null,
    sold_quantity_positive: fullAnalysis?.sold_quantity_positive ?? false,
    sold_quantity_present: fullAnalysis?.field_present ?? false,
    sold_quantity_absent: full.ok && !fullAnalysis?.field_present,
    sold_quantity_null: fullAnalysis?.diagnosis === "sold_quantity_null",
    sold_quantity_zero: fullAnalysis?.diagnosis === "sold_quantity_zero",
    alternative_sales_fields: fullAnalysis?.alternative_sales_fields ?? {},
    sanitized_fields: full.ok ? sanitizeItemRelevantFields(full.json) : null,
    failure_class: full.ok ? null : classifyHttpFailure(full.status, full.json),
    error_message: full.ok ? null : full.json?.message ?? full.json?.error ?? null,
    diagnosis: fullAnalysis?.diagnosis ?? (full.ok ? null : "request_failed"),
  });

  const attrs = await fetchItemEndpoint(accessToken, itemId, ITEM_ATTRIBUTES_QUERY);
  endpointsChecked.push(`GET /items/${itemId}?attributes=${ITEM_ATTRIBUTES_QUERY}`);
  const attrsAnalysis = attrs.ok ? analyzeSoldQuantityField(attrs.json) : null;
  const attrsEvidence = buildSoldQuantityEvidence(attrs.status, attrsAnalysis, attrs.ok);

  logDirectItemAudit({
    phase: "attributes_item",
    item_id: itemId,
    endpoint: `GET /items/${itemId}?attributes=${ITEM_ATTRIBUTES_QUERY}`,
    url: attrs.url,
    http_status: attrs.status,
    http_ok: attrs.ok,
    sold_quantity_evidence: attrsEvidence,
    item_seller_id: attrs.ok ? pickItemSellerId(attrs.json) : itemSellerId,
    connected_seller_id: connectedSellerId,
    has_sold_quantity_field: attrsAnalysis?.field_present ?? false,
    sold_quantity_raw: attrsAnalysis?.sold_quantity_raw ?? null,
    sold_quantity_positive: attrsAnalysis?.sold_quantity_positive ?? false,
    sold_quantity_present: attrsAnalysis?.field_present ?? false,
    sold_quantity_absent: attrs.ok && !attrsAnalysis?.field_present,
    sold_quantity_null: attrsAnalysis?.diagnosis === "sold_quantity_null",
    sold_quantity_zero: attrsAnalysis?.diagnosis === "sold_quantity_zero",
    sanitized_fields: attrs.ok ? sanitizeItemRelevantFields(attrs.json) : null,
    attributes_match_full:
      full.ok && attrs.ok
        ? String(full.json?.sold_quantity ?? "") === String(attrs.json?.sold_quantity ?? "")
        : null,
    failure_class: attrs.ok ? null : classifyHttpFailure(attrs.status, attrs.json),
    error_message: attrs.ok ? null : attrs.json?.message ?? attrs.json?.error ?? null,
    diagnosis: attrsAnalysis?.diagnosis ?? (attrs.ok ? null : "request_failed"),
  });

  let ownComparison = null;
  if (ownListingId && ownListingId !== itemId) {
    const own = await fetchItemEndpoint(accessToken, ownListingId);
    endpointsChecked.push(`GET /items/${ownListingId} (own_listing)`);
    const ownAnalysis = own.ok ? analyzeSoldQuantityField(own.json) : null;
    ownComparison = {
      own_listing_id: ownListingId,
      own_http_status: own.status,
      own_seller_id: own.ok ? pickItemSellerId(own.json) : null,
      own_has_sold_quantity: ownAnalysis?.field_present ?? false,
      own_sold_quantity_raw: ownAnalysis?.sold_quantity_raw ?? null,
      own_sold_quantity_positive: ownAnalysis?.sold_quantity_positive ?? false,
      competitor_sold_quantity_positive: fullAnalysis?.sold_quantity_positive ?? false,
      likely_permission_limitation:
        (ownAnalysis?.sold_quantity_positive ?? false) && !(fullAnalysis?.sold_quantity_positive ?? false),
    };
    logDirectItemAudit({
      phase: "own_vs_competitor",
      item_id: itemId,
      ...ownComparison,
    });
  }

  const soldFromFull = full.ok ? pickSoldQuantityFromMlBody(full.json) : null;
  const soldFromAttrs = attrs.ok ? pickSoldQuantityFromMlBody(attrs.json) : null;
  const salesHint = soldFromFull ?? soldFromAttrs ?? null;
  const resolved = salesHint != null;

  const technicalDiagnosis = {
    seller_id: itemSellerId,
    item_seller_id: itemSellerId,
    connected_seller_id: connectedSellerId,
    is_third_party_listing: isThirdParty,
    urls: [full.url, attrs.url],
    full_status: full.status,
    full_http_ok: full.ok,
    full_sold_quantity_evidence: fullEvidence,
    attributes_status: attrs.status,
    attributes_http_ok: attrs.ok,
    attributes_sold_quantity_evidence: attrsEvidence,
    fields_returned_full: full.ok ? Object.keys(full.json || {}).slice(0, 40) : [],
    fields_returned_attributes: attrs.ok ? Object.keys(attrs.json || {}).slice(0, 20) : [],
    sold_quantity_full: fullAnalysis,
    sold_quantity_attributes: attrsAnalysis,
    failure_class_full: full.ok ? null : classifyHttpFailure(full.status, full.json),
    failure_class_attributes: attrs.ok ? null : classifyHttpFailure(attrs.status, attrs.json),
    own_vs_competitor: ownComparison,
    scenario: resolved ? "A_ml_returns_sold_quantity" : "B_ml_no_sold_quantity_for_competitor",
    recommendation: resolved
      ? "CENARIO_A_sold_quantity_disponivel_via_GET_items_pipeline_deve_propagar"
      : !full.ok && full.status === 403
        ? "CENARIO_B_endpoint_403_sold_quantity_indisponivel_terceiros"
        : ownComparison?.likely_permission_limitation
          ? "CENARIO_B_own_tem_sold_quantity_competitor_nao_token_nao_proprietario"
          : full.ok && fullAnalysis?.field_present && fullAnalysis?.sold_quantity_raw === null
            ? "CENARIO_B_campo_presente_null"
            : full.ok && !fullAnalysis?.field_present
              ? "CENARIO_B_campo_ausente_resposta_200"
              : !full.ok
                ? `CENARIO_B_endpoint_bloqueado_${classifyHttpFailure(full.status, full.json)}`
                : "CENARIO_B_sold_quantity_ausente_ou_nao_positivo_resposta_real",
  };

  logDirectItemAudit({
    phase: "final_diagnosis",
    item_id: itemId,
    resolved,
    scenario: technicalDiagnosis.scenario,
    sales_hint: salesHint,
    sales_hint_source: resolved ? "ml_items_sold_quantity" : null,
    ...technicalDiagnosis,
  });

  logAuditEnd({
    item_id: itemId,
    trigger,
    connected_seller_id: connectedSellerId,
    item_seller_id: itemSellerId,
    is_third_party_listing: isThirdParty,
    resolved,
    scenario: technicalDiagnosis.scenario,
    sales_hint: salesHint,
    sales_hint_source: resolved ? "ml_items_sold_quantity" : null,
    full_http_status: full.status,
    full_sold_quantity_evidence: fullEvidence,
    attributes_http_status: attrs.status,
    attributes_sold_quantity_evidence: attrsEvidence,
    recommendation: technicalDiagnosis.recommendation,
    endpoints_checked: endpointsChecked,
    at: new Date().toISOString(),
  });

  if (!salesHint) {
    return {
      hit: null,
      resolved: false,
      scenario: technicalDiagnosis.scenario,
      resolution: {
        sales_hint: null,
        sales_hint_source: null,
        sales_hint_confidence: null,
        sales_hint_checked_at: checkedAt,
        diagnostics: technicalDiagnosis,
      },
      endpoints_checked: endpointsChecked,
      diagnosis: technicalDiagnosis,
    };
  }

  const hit = {
    sales_hint: salesHint,
    source: "ml_items_sold_quantity",
    confidence: "high",
  };

  return {
    hit,
    resolved: true,
    scenario: technicalDiagnosis.scenario,
    resolution: {
      sales_hint: salesHint,
      sales_hint_source: hit.source,
      sales_hint_confidence: hit.confidence,
      sales_hint_checked_at: checkedAt,
    },
    endpoints_checked: endpointsChecked,
    diagnosis: technicalDiagnosis,
  };
}
