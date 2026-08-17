// ============================================================
// S7 — Concorrência: resolver dedicado de vendas do concorrente
// Camada separada — não acoplada ao enrich principal.
// ============================================================

import {
  fetchItemsByIds,
  fetchItemDescription,
  fetchItemVisitsTotal,
  fetchCatalogProductItemsSafe,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { buildMercadoLivreItemPermalink } from "./mlListingDisplay.js";
import { competitionSalesAuditEnabled, logSalesRawMl, logSalesUnavailable } from "./competitionSalesMlAudit.js";
import { runDirectItemSoldQuantityAudit } from "./competitionDirectItemAudit.js";
import { getSalesHintCached, setSalesHintCached } from "./competitionSalesHintCache.js";
import {
  isMlPublicPageBlocked,
  pickSoldQuantityFromMlBody,
  pickSoldQuantityFromPublicHtml,
} from "./competitionSalesHintParse.js";

const ML_API = "https://api.mercadolibre.com";
const PUBLIC_FETCH_TIMEOUT_MS = 10000;
const PUBLIC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * @typedef {'high' | 'medium' | 'low'} SalesHintConfidence
 * @typedef {{
 *   sales_hint: number | null;
 *   sales_hint_source: string | null;
 *   sales_hint_confidence: SalesHintConfidence | null;
 *   sales_hint_checked_at: string;
 *   diagnostics?: { endpoints_checked: string[]; public_page_blocked?: boolean; recommendation?: string };
 * }} SalesHintResolution
 */

function emptyResolution(checkedAt = new Date().toISOString()) {
  return {
    sales_hint: null,
    sales_hint_source: null,
    sales_hint_confidence: null,
    sales_hint_checked_at: checkedAt,
  };
}

function logResolverAudit(payload) {
  if (!competitionSalesAuditEnabled()) return;
  console.info("[S7_COMPETITION_SALES_HINT_RESOLVER]", payload);
}

async function fetchMlJson(url, { accessToken = null, timeoutMs = 12000 } = {}) {
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

async function tryDirectItemSoldQuantityAudit(accessToken, itemId, endpointsChecked, opts = {}) {
  const audit = await runDirectItemSoldQuantityAudit({
    accessToken,
    item_id: itemId,
    connected_seller_id: opts.connected_seller_id ?? null,
    own_listing_id: opts.own_listing_id ?? null,
    trigger: "sales_hint_resolver",
  });
  if (Array.isArray(audit.endpoints_checked)) {
    endpointsChecked.push(...audit.endpoints_checked);
  }
  return audit.hit;
}

async function tryMlItemsMultiget(accessToken, itemId, endpointsChecked) {
  try {
    const map = await fetchItemsByIds(accessToken, [itemId]);
    const item = map.get(itemId) ?? null;
    endpointsChecked.push(`GET /items?ids=${itemId}`);
    logSalesRawMl({
      item_id: itemId,
      endpoint: `GET /items?ids=${itemId}`,
      status: item ? 200 : 403,
      body: item,
    });
    if (item) {
      const n = pickSoldQuantityFromMlBody(item);
      if (n != null) return { sales_hint: n, source: "ml_items_multiget", confidence: "high" };
    }
  } catch (e) {
    endpointsChecked.push(`GET /items?ids=${itemId}:${e?.status ?? "error"}`);
  }
  return null;
}

async function tryMlItemsPublic(itemId, endpointsChecked) {
  const url = `${ML_API}/items/${encodeURIComponent(itemId)}?attributes=sold_quantity`;
  const { ok, status, json } = await fetchMlJson(url);
  endpointsChecked.push(`GET /items/${itemId}?attributes=sold_quantity (public)`);
  logSalesRawMl({
    item_id: itemId,
    endpoint: `GET /items/${itemId}?attributes=sold_quantity (public)`,
    status,
    body: json,
  });
  if (ok && json) {
    const n = pickSoldQuantityFromMlBody(json);
    if (n != null) return { sales_hint: n, source: "ml_items_public", confidence: "medium" };
  }
  return null;
}

async function tryMlItemDescription(accessToken, itemId, endpointsChecked) {
  try {
    const desc = await fetchItemDescription(accessToken, itemId);
    endpointsChecked.push(`GET /items/${itemId}/description`);
    logSalesRawMl({
      item_id: itemId,
      endpoint: `GET /items/${itemId}/description`,
      status: 200,
      body: { keys: Object.keys(desc || {}).slice(0, 12) },
    });
    const plain = desc?.plain_text != null ? String(desc.plain_text) : "";
    const html = desc?.text != null ? String(desc.text) : desc?.html_text != null ? String(desc.html_text) : "";
    const fromText = pickSoldQuantityFromPublicHtml(`${plain}\n${html}`);
    if (fromText.value != null) {
      return {
        sales_hint: fromText.value,
        source: "ml_item_description_text",
        confidence: "low",
      };
    }
  } catch (e) {
    endpointsChecked.push(`GET /items/${itemId}/description:${e?.status ?? "error"}`);
  }
  return null;
}

async function tryMlItemVisits(accessToken, itemId, endpointsChecked) {
  try {
    const v = await fetchItemVisitsTotal(accessToken, itemId);
    endpointsChecked.push(`GET /items/${itemId}/visits`);
    logSalesRawMl({
      item_id: itemId,
      endpoint: `GET /items/${itemId}/visits`,
      status: 200,
      body: { total_visits: v?.total ?? null, note: "visits_not_sales" },
    });
  } catch (e) {
    endpointsChecked.push(`GET /items/${itemId}/visits:${e?.status ?? "error"}`);
  }
  return null;
}

async function tryMlCatalogProductItems(accessToken, itemId, catalogProductId, endpointsChecked) {
  const productId = String(catalogProductId || "").trim();
  if (!productId) return null;
  const res = await fetchCatalogProductItemsSafe(accessToken, productId, { limit: 50 });
  endpointsChecked.push(`GET /products/${productId}/items`);
  const row = (res.results || []).find(
    (r) => String(r?.item_id || r?.id || "").trim() === String(itemId).trim()
  );
  if (row) {
    logSalesRawMl({
      item_id: itemId,
      endpoint: `GET /products/${productId}/items`,
      status: res.status,
      body: row,
    });
    const n = pickSoldQuantityFromMlBody(row);
    if (n != null) return { sales_hint: n, source: "ml_catalog_product_items", confidence: "medium" };
  }
  return null;
}

async function tryMlPublicPermalink(permalink, itemId, endpointsChecked) {
  const url = String(permalink || "").trim() || buildMercadoLivreItemPermalink(itemId);
  if (!url) return { hit: null, blocked: false };

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "User-Agent": PUBLIC_UA,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(PUBLIC_FETCH_TIMEOUT_MS),
    });
    endpointsChecked.push(`GET ${url} (public_html)`);
    const html = await res.text();
    if (!res.ok) {
      logSalesRawMl({
        item_id: itemId,
        endpoint: `GET permalink (public_html)`,
        status: res.status,
        body: { bytes: html.length },
      });
      return { hit: null, blocked: false };
    }

    if (isMlPublicPageBlocked(html)) {
      logResolverAudit({
        item_id: itemId,
        public_page_blocked: true,
        html_bytes: html.length,
        note: "ml_suspicious_traffic_page",
      });
      return { hit: null, blocked: true };
    }

    const parsed = pickSoldQuantityFromPublicHtml(html);
    logSalesRawMl({
      item_id: itemId,
      endpoint: `GET permalink (public_html)`,
      status: res.status,
      body: {
        html_bytes: html.length,
        pattern: parsed.pattern,
        parsed_sales: parsed.value,
      },
    });

    if (parsed.value != null) {
      return {
        hit: {
          sales_hint: parsed.value,
          source: `ml_public_page_${parsed.pattern || "html"}`,
          confidence: "low",
        },
        blocked: false,
      };
    }
    return { hit: null, blocked: false };
  } catch (e) {
    endpointsChecked.push(`GET permalink:${e?.message ?? "error"}`);
    return { hit: null, blocked: false };
  }
}

/**
 * Resolve quantidade de vendas do concorrente tentando fontes em ordem segura.
 * @param {{
 *   accessToken?: string | null;
 *   item_id: string;
 *   permalink?: string | null;
 *   catalog_product_id?: string | null;
 *   marketplace_account_id?: string | null;
 *   connected_seller_id?: string | null;
 *   own_listing_id?: string | null;
 *   skip_cache?: boolean;
 *   skip_direct_audit?: boolean;
 * }} opts
 * @returns {Promise<SalesHintResolution>}
 */
export async function resolveCompetitionSalesHint(opts = {}) {
  const itemId = String(opts.item_id || "").trim();
  const checkedAt = new Date().toISOString();
  if (!itemId) return emptyResolution(checkedAt);

  if (!opts.skip_cache) {
    const cached = getSalesHintCached(itemId);
    if (cached) return cached;
  }

  const endpointsChecked = [];
  const accessToken = opts.accessToken ?? null;
  let publicPageBlocked = false;

  const tryHit = (hit) => {
    if (!hit?.sales_hint) return null;
    return {
      sales_hint: hit.sales_hint,
      sales_hint_source: hit.source ?? null,
      sales_hint_confidence: hit.confidence ?? null,
      sales_hint_checked_at: checkedAt,
    };
  };

  if (accessToken) {
    if (!opts.skip_direct_audit) {
      const directHit = await tryDirectItemSoldQuantityAudit(accessToken, itemId, endpointsChecked, {
        connected_seller_id: opts.connected_seller_id ?? null,
        own_listing_id: opts.own_listing_id ?? null,
      });
      const directResolved = tryHit(directHit);
      if (directResolved) {
        setSalesHintCached(itemId, directResolved);
        logResolverAudit({ item_id: itemId, ...directResolved, endpoints_checked: endpointsChecked });
        return directResolved;
      }
    }

    for (const fn of [
      () => tryMlItemsMultiget(accessToken, itemId, endpointsChecked),
      () => tryMlCatalogProductItems(accessToken, itemId, opts.catalog_product_id, endpointsChecked),
      () => tryMlItemDescription(accessToken, itemId, endpointsChecked),
    ]) {
      const hit = await fn();
      const resolved = tryHit(hit);
      if (resolved) {
        setSalesHintCached(itemId, resolved);
        logResolverAudit({ item_id: itemId, ...resolved, endpoints_checked: endpointsChecked });
        return resolved;
      }
    }
    await tryMlItemVisits(accessToken, itemId, endpointsChecked);
  }

  const publicApiHit = await tryMlItemsPublic(itemId, endpointsChecked);
  const publicApiResolved = tryHit(publicApiHit);
  if (publicApiResolved) {
    setSalesHintCached(itemId, publicApiResolved);
    logResolverAudit({ item_id: itemId, ...publicApiResolved, endpoints_checked: endpointsChecked });
    return publicApiResolved;
  }

  const permalinkResult = await tryMlPublicPermalink(opts.permalink, itemId, endpointsChecked);
  publicPageBlocked = permalinkResult.blocked;
  const publicPageResolved = tryHit(permalinkResult.hit);
  if (publicPageResolved) {
    setSalesHintCached(itemId, publicPageResolved);
    logResolverAudit({ item_id: itemId, ...publicPageResolved, endpoints_checked: endpointsChecked });
    return publicPageResolved;
  }

  const recommendation = publicPageBlocked
    ? "ML bloqueou HTML server-side (suspicious-traffic); API autenticada não expõe sold_quantity para terceiros — vendas indisponíveis sem token proprietário."
    : "Nenhuma fonte oficial retornou sold_quantity confiável para este concorrente com o token atual.";

  logSalesUnavailable({
    item_id: itemId,
    reason: publicPageBlocked ? "public_page_blocked_and_api_no_sold_quantity" : "no_confident_sales_source",
    endpoints_checked: endpointsChecked,
  });

  const unresolved = {
    ...emptyResolution(checkedAt),
    diagnostics: {
      endpoints_checked: endpointsChecked,
      public_page_blocked: publicPageBlocked,
      recommendation,
    },
  };
  setSalesHintCached(itemId, unresolved);
  logResolverAudit({ item_id: itemId, unresolved: true, ...unresolved.diagnostics });
  return unresolved;
}

/** Mescla resolução no objeto enrichExtras sem sobrescrever vendas já conhecidas. */
export function applySalesHintResolutionToExtras(extras, resolution) {
  const base = extras && typeof extras === "object" ? { ...extras } : {};
  if (!resolution) return base;
  const current = Number(base.sales_hint);
  if (Number.isFinite(current) && current > 0) {
    return base;
  }
  if (resolution.sales_hint != null && Number(resolution.sales_hint) > 0) {
    base.sales_hint = Math.trunc(Number(resolution.sales_hint));
    base.sales_hint_source = resolution.sales_hint_source ?? null;
    base.sales_hint_confidence = resolution.sales_hint_confidence ?? null;
    base.sales_hint_checked_at = resolution.sales_hint_checked_at ?? null;
  }
  return base;
}

/** Enriquece candidatos discover (paralelo limitado) com vendas quando possível. */
export async function resolveSalesHintsForDiscoverCandidates(accessToken, candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return list;

  const concurrency = Number.isFinite(Number(opts.concurrency)) ? Math.min(Number(opts.concurrency), 5) : 3;
  const max = Number.isFinite(Number(opts.max)) ? Math.min(Number(opts.max), 20) : 12;
  const targets = list.filter((c) => {
    const n = Number(c?.sales_hint);
    return !(Number.isFinite(n) && n > 0);
  }).slice(0, max);

  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (cand) => {
        const itemId = String(cand?.competitor_listing_id || "").trim();
        if (!itemId) return;
        const resolution = await resolveCompetitionSalesHint({
          accessToken,
          item_id: itemId,
          permalink: cand?.competitor_permalink ?? null,
          catalog_product_id: opts.catalog_product_id ?? null,
          connected_seller_id: opts.connected_seller_id ?? null,
          own_listing_id: opts.own_listing_id ?? null,
        });
        if (resolution.sales_hint != null) {
          cand.sales_hint = resolution.sales_hint;
          cand.sales_hint_source = resolution.sales_hint_source;
          cand.sales_hint_confidence = resolution.sales_hint_confidence;
          cand.sales_hint_checked_at = resolution.sales_hint_checked_at;
        }
      })
    );
  }
  return list;
}
