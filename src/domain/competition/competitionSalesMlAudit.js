// ============================================================
// S7 — Concorrência: auditoria DEV de sold_quantity (Mercado Livre)
// Diagnóstico: ML retorna vendas para concorrentes ou é limitação de API?
// ============================================================

import {
  fetchItem,
  fetchItemsByIds,
  fetchCatalogProductItemsSafe,
  searchCatalogProducts,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";

/**
 * Auditoria de vendas (logs S7_COMPETITION_*).
 * No Vercel, NODE_ENV costuma ser "production" mesmo em suse7-backend-dev —
 * por isso não dependemos só de NODE_ENV.
 */
export function competitionSalesAuditEnabled() {
  const explicit = String(process.env.S7_COMPETITION_SALES_AUDIT ?? "").trim();
  if (explicit === "1") return true;
  if (explicit === "0") return false;

  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  if (vercelEnv === "development" || vercelEnv === "preview") return true;

  const vercelHost = String(
    process.env.VERCEL_URL || process.env.VERCEL_BRANCH_URL || ""
  ).toLowerCase();
  if (vercelHost.includes("backend-dev")) return true;

  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

/** Prova de carregamento do módulo de auditoria (sempre emite, sem gate). */
function logCompetitionAuditBoot() {
  console.info("[S7_COMPETITION_AUDIT_BOOT]", {
    module: "competitionSalesMlAudit",
    audit_enabled: competitionSalesAuditEnabled(),
    node_env: process.env.NODE_ENV ?? null,
    vercel_env: process.env.VERCEL_ENV ?? null,
    vercel_url: process.env.VERCEL_URL ?? null,
    sales_audit_flag: process.env.S7_COMPETITION_SALES_AUDIT ?? null,
    at: new Date().toISOString(),
  });
}

logCompetitionAuditBoot();

/** Extrai sold_quantity do corpo ML (campo pode existir com valor 0). */
export function extractSoldQuantityFromMlBody(body) {
  if (!body || typeof body !== "object") {
    return {
      has_sold_quantity: false,
      field_present: false,
      sold_quantity: null,
      available_quantity: null,
    };
  }
  const fieldPresent = "sold_quantity" in body && body.sold_quantity != null && body.sold_quantity !== "";
  const soldN = Number(body.sold_quantity);
  const hasPositive = Number.isFinite(soldN) && soldN > 0;
  return {
    has_sold_quantity: hasPositive,
    field_present: fieldPresent,
    sold_quantity: body.sold_quantity ?? null,
    available_quantity: body.available_quantity ?? null,
  };
}

/**
 * Log seguro do payload ML (sem token).
 * @param {{ item_id?: string | null; endpoint: string; status?: number | null; body?: unknown; error?: string | null }} params
 */
export function logSalesRawMl({ item_id, endpoint, status, body, error = null }) {
  if (!competitionSalesAuditEnabled()) return;
  const record = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  const keys = record ? Object.keys(record).slice(0, 48) : [];
  const sq = extractSoldQuantityFromMlBody(record);
  console.info("[S7_COMPETITION_SALES_RAW_ML]", {
    item_id: item_id ?? record?.id ?? record?.item_id ?? null,
    endpoint,
    status: status ?? null,
    has_sold_quantity: sq.has_sold_quantity,
    field_present: sq.field_present,
    sold_quantity: sq.sold_quantity,
    available_quantity: sq.available_quantity,
    raw_keys: keys,
    error: error ?? null,
  });
}

export function logSalesUnavailable({ item_id, reason, endpoints_checked }) {
  if (!competitionSalesAuditEnabled()) return;
  console.info("[S7_COMPETITION_SALES_UNAVAILABLE]", {
    item_id: item_id ?? null,
    reason: reason ?? "sold_quantity_indisponivel",
    endpoints_checked: Array.isArray(endpoints_checked) ? endpoints_checked : [],
  });
}

/** Loga linha de catálogo /products/{id}/items (pode não trazer sold_quantity). */
export function logSalesRawCatalogItemRow(itemId, catalogProductId, row, status = 200) {
  if (!competitionSalesAuditEnabled()) return;
  const body = row && typeof row === "object" ? row : null;
  logSalesRawMl({
    item_id: itemId ?? body?.item_id ?? body?.id ?? null,
    endpoint: `GET /products/${catalogProductId}/items`,
    status,
    body,
  });
}

/** Loga amostra de GET /products/search (produtos de catálogo — raramente têm sold_quantity). */
export function logSalesRawCatalogSearch(query, status, results) {
  if (!competitionSalesAuditEnabled()) return;
  const sample = Array.isArray(results) && results.length > 0 ? results[0] : null;
  const keys = sample && typeof sample === "object" ? Object.keys(sample).slice(0, 32) : [];
  console.info("[S7_COMPETITION_SALES_RAW_ML]", {
    item_id: null,
    endpoint: `GET /products/search?q=${String(query || "").slice(0, 80)}`,
    status: status ?? null,
    has_sold_quantity: false,
    field_present: sample != null && "sold_quantity" in sample,
    sold_quantity: sample?.sold_quantity ?? null,
    available_quantity: null,
    raw_keys: keys,
    error: null,
  });
}

/**
 * Compara item próprio do seller vs concorrente (mesmo token ML).
 * @param {string} accessToken
 * @param {string} ownListingId
 * @param {string} competitorListingId
 */
export async function auditOwnVsCompetitorSales(accessToken, ownListingId, competitorListingId) {
  if (!competitionSalesAuditEnabled() || !accessToken) return;

  const ownId = String(ownListingId || "").trim();
  const compId = String(competitorListingId || "").trim();
  if (!ownId || !compId) return;

  const endpoints_checked = [];
  let ownSq = { has_sold_quantity: false, field_present: false, sold_quantity: null };
  let compSq = { has_sold_quantity: false, field_present: false, sold_quantity: null };

  try {
    const own = await fetchItem(accessToken, ownId);
    logSalesRawMl({
      item_id: ownId,
      endpoint: `GET /items/${ownId}`,
      status: 200,
      body: own,
    });
    endpoints_checked.push(`GET /items/${ownId} (own)`);
    ownSq = extractSoldQuantityFromMlBody(own);
  } catch (e) {
    logSalesRawMl({
      item_id: ownId,
      endpoint: `GET /items/${ownId}`,
      status: e?.status ?? null,
      body: e?.body ?? null,
      error: e?.message ?? String(e),
    });
    endpoints_checked.push(`GET /items/${ownId} (own):${e?.status ?? "error"}`);
  }

  try {
    const comp = await fetchItem(accessToken, compId);
    logSalesRawMl({
      item_id: compId,
      endpoint: `GET /items/${compId}`,
      status: 200,
      body: comp,
    });
    endpoints_checked.push(`GET /items/${compId} (competitor)`);
    compSq = extractSoldQuantityFromMlBody(comp);
  } catch (e) {
    logSalesRawMl({
      item_id: compId,
      endpoint: `GET /items/${compId}`,
      status: e?.status ?? null,
      body: e?.body ?? null,
      error: e?.message ?? String(e),
    });
    endpoints_checked.push(`GET /items/${compId} (competitor):${e?.status ?? "error"}`);
  }

  try {
    const map = await fetchItemsByIds(accessToken, [compId]);
    const mult = map.get(compId) ?? null;
    logSalesRawMl({
      item_id: compId,
      endpoint: `GET /items?ids=${compId}`,
      status: mult ? 200 : 403,
      body: mult,
    });
    endpoints_checked.push(`GET /items?ids=${compId} (competitor)`);
    if (!compSq.has_sold_quantity && mult) {
      const m = extractSoldQuantityFromMlBody(mult);
      if (m.has_sold_quantity) compSq = m;
    }
  } catch (e) {
    endpoints_checked.push(`GET /items?ids=${compId}:${e?.status ?? "error"}`);
  }

  const likelyLimitation = ownSq.has_sold_quantity && !compSq.has_sold_quantity;

  console.info("[S7_COMPETITION_SALES_AUDIT] own_vs_competitor", {
    own_listing_id: ownId,
    competitor_listing_id: compId,
    own_has_sold_quantity: ownSq.has_sold_quantity,
    own_field_present: ownSq.field_present,
    own_sold_quantity: ownSq.sold_quantity,
    competitor_has_sold_quantity: compSq.has_sold_quantity,
    competitor_field_present: compSq.field_present,
    competitor_sold_quantity: compSq.sold_quantity,
    likely_api_or_permission_limitation: likelyLimitation,
  });

  if (!compSq.has_sold_quantity) {
    logSalesUnavailable({
      item_id: compId,
      reason: likelyLimitation
        ? "own_listing_has_sold_quantity_competitor_does_not_likely_ml_api_limitation"
        : ownSq.has_sold_quantity
          ? "competitor_sold_quantity_not_in_ml_response"
          : "sold_quantity_absent_in_own_and_competitor_items_response",
      endpoints_checked,
    });
  }
}

/**
 * Auditoria completa de um item concorrente (DEV) — usa endpoints já previstos na missão.
 * @param {string} accessToken
 * @param {string} itemId
 * @param {{ catalogProductId?: string | null; searchQuery?: string | null }} [opts]
 */
export async function auditCompetitorSalesEndpoints(accessToken, itemId, opts = {}) {
  if (!competitionSalesAuditEnabled() || !accessToken || !itemId) return;

  const lid = String(itemId).trim();
  const endpoints_checked = [];
  let found = false;

  try {
    const item = await fetchItem(accessToken, lid);
    logSalesRawMl({ item_id: lid, endpoint: `GET /items/${lid}`, status: 200, body: item });
    endpoints_checked.push(`GET /items/${lid}`);
    if (extractSoldQuantityFromMlBody(item).has_sold_quantity) found = true;
  } catch (e) {
    logSalesRawMl({
      item_id: lid,
      endpoint: `GET /items/${lid}`,
      status: e?.status ?? null,
      body: e?.body ?? null,
      error: e?.message ?? null,
    });
    endpoints_checked.push(`GET /items/${lid}:${e?.status ?? "error"}`);
  }

  const catalogProductId = opts.catalogProductId != null ? String(opts.catalogProductId).trim() : "";
  if (catalogProductId) {
    const res = await fetchCatalogProductItemsSafe(accessToken, catalogProductId, { limit: 50 });
    endpoints_checked.push(`GET /products/${catalogProductId}/items`);
    const row = (res.results || []).find(
      (r) => String(r?.item_id || r?.id || "") === lid
    );
    if (row) {
      logSalesRawCatalogItemRow(lid, catalogProductId, row, res.status);
      if (extractSoldQuantityFromMlBody(row).has_sold_quantity) found = true;
    } else {
      logSalesRawMl({
        item_id: lid,
        endpoint: `GET /products/${catalogProductId}/items`,
        status: res.status,
        body: { note: "item_id_not_in_catalog_items_page", results_count: res.results?.length ?? 0 },
      });
    }
  }

  const searchQuery = opts.searchQuery != null ? String(opts.searchQuery).trim() : "";
  if (searchQuery) {
    try {
      const r = await searchCatalogProducts(accessToken, { q: searchQuery, limit: 5, offset: 0 });
      logSalesRawCatalogSearch(searchQuery, 200, r.results);
      endpoints_checked.push(`GET /products/search?q=${searchQuery.slice(0, 40)}`);
    } catch (e) {
      endpoints_checked.push(`GET /products/search:${e?.status ?? "error"}`);
    }
  }

  if (!found) {
    logSalesUnavailable({
      item_id: lid,
      reason: "sold_quantity_not_found_in_audited_endpoints",
      endpoints_checked,
    });
  }
}
