// ==================================================
// SUSE7 — API ROUTER ÚNICO (Vercel Hobby Limit Fix)
// Arquivo: api/index.js
//
// Objetivo:
// - Evitar limite de 12 Serverless Functions no plano Hobby
// - Roteamento interno por URL (1 única função /api)
// - CORS centralizado
// - OPTIONS: hard stop no topo, nunca executa parse/roteamento
// - Lazy import: handlers carregados só quando a rota é chamada
// ==================================================

import { applyCors } from "../src/middlewares/cors.js";

const DEBUG_ML_FIELD_MAP_PATH = "/api/debug/marketplaces/mercado-livre/listings/field-map";
const DEBUG_ML_COVER_COMPARE_PATH = "/api/debug/ml/listing-cover-compare";
const DEBUG_ML_LISTINGS_COVER_CONTEXT_PATH = "/api/debug/ml/listings-cover-context";
console.log("[S7 API Router] boot — rotas diagnóstico ML:", DEBUG_ML_FIELD_MAP_PATH, DEBUG_ML_COVER_COMPARE_PATH, DEBUG_ML_LISTINGS_COVER_CONTEXT_PATH);
console.log("[S7 API Router] boot — ML OAuth diag: GET /api/ml/oauth-config");

/**
 * Resolve rota lógica para o router único (/api + __path no Vercel).
 * Cobre pathname completo, query só com __path, e req.url malformado.
 * @param {string} rawUrl
 * @param {string} baseUrl
 */
function resolveRouterPath(rawUrl, baseUrl) {
  const url = new URL(rawUrl || "/api", baseUrl);
  const from__path = (paramRaw) => {
    if (paramRaw == null || String(paramRaw).trim() === "") return null;
    let pathParam = String(paramRaw).trim();
    try {
      pathParam = decodeURIComponent(pathParam);
    } catch {
      /* manter */
    }
    pathParam = pathParam.replace(/^\/+|\/+$/g, "");
    if (pathParam.startsWith("api/")) {
      pathParam = pathParam.replace(/^api\/+/, "");
    }
    return `/api/${pathParam}`.replace(/\/+$/, "") || "/api";
  };

  const q = url.searchParams.get("__path");
  if (q != null && String(q).trim() !== "") {
    const p = from__path(q);
    if (p) return p;
  }

  let path = (url.pathname || "/").replace(/\/+$/, "") || "/";

  // req.url só com query (?__path=) — alguns runtimes entregam pathname vazio ou /
  if ((path === "/" || path === "/api") && typeof rawUrl === "string" && rawUrl.includes("__path=")) {
    const qs = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : `?${rawUrl}`;
    try {
      const sp = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
      const p2 = sp.get("__path");
      const p = from__path(p2);
      if (p && p !== "/api") return p;
    } catch {
      /* ignore */
    }
  }

  return path;
}

// ==================================================
// Router
// ==================================================
export default async function handler(req, res) {
  // ------------------------------
  // FASE 3: OPTIONS retorna 204 antes de qualquer parse
  // ------------------------------
  const finished = applyCors(req, res);
  if (finished) return;

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // ------------------------------
  // Agora pode parsear URL e rotear
  // ------------------------------
  try {
    const baseUrl = `http://${req.headers?.host || "localhost"}`;
    const rawUrl = req.url || "/api";
    const url = new URL(rawUrl, baseUrl);
    const path = resolveRouterPath(rawUrl, baseUrl);

    req.query = Object.fromEntries(url.searchParams);

    // ------------------------------
    // Health check (DEV e produção) — GET /api/health
    // ------------------------------
    if (path === "/api/health") {
      return res.status(200).json({
        ok: true,
        service: "suse7-backend",
        timestamp: new Date().toISOString(),
      });
    }

    // ------------------------------
    // Rotas (lazy import — FASE 2)
    // ------------------------------
    if (path === "/api/user/preferences") {
      const mod = await import("../src/handlers/user/preferences.js");
      return mod.handleUserPreferences(req, res);
    }
    if (path === "/api/user/preferences/reset") {
      const mod = await import("../src/handlers/user/preferencesReset.js");
      return mod.handleUserPreferencesReset(req, res);
    }
    if (path === "/api/notifications") {
      const mod = await import("../src/handlers/notifications/index.js");
      return mod.handleNotifications(req, res);
    }
    if (path === "/api/notifications/mark-read") {
      const mod = await import("../src/handlers/notifications/markRead.js");
      return mod.handleNotificationsMarkRead(req, res);
    }
    if (path === "/api/drafts/upsert") {
      const mod = await import("../src/handlers/drafts/upsert.js");
      return mod.handleDraftsUpsert(req, res);
    }
    if (path === DEBUG_ML_FIELD_MAP_PATH) {
      const mod = await import("../src/handlers/debug/mlListingFieldMap.js");
      return await mod.default(req, res);
    }
    if (path === DEBUG_ML_COVER_COMPARE_PATH) {
      const mod = await import("../src/handlers/debug/mlListingCoverCompare.js");
      return await mod.default(req, res);
    }
    if (path === DEBUG_ML_LISTINGS_COVER_CONTEXT_PATH) {
      const mod = await import("../src/handlers/debug/mlListingsCoverContextDebug.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/oauth-config") {
      const mod = await import("../src/handlers/ml/oauthConfigProbe.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/connect") {
      const mod = await import("../src/handlers/ml/connect.js");
      return await mod.handleMlConnect(req, res);
    }
    if (path === "/api/ml/callback") {
      const mod = await import("../src/handlers/ml/callback.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/status") {
      const mod = await import("../src/handlers/ml/status.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/sync-listings") {
      const mod = await import("../src/handlers/ml/listingsSync.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/auto-sync-listings") {
      const mod = await import("../src/handlers/ml/listingsAutoSync.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/backfill-listing-health") {
      const mod = await import("../src/handlers/ml/listingsHealthBackfill.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/listings") {
      const mod = await import("../src/handlers/ml/listingsList.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/listings/set-sku") {
      const mod = await import("../src/handlers/ml/listingSetSku.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/listings/pricing-scenarios") {
      const mod = await import("../src/handlers/ml/listingPricingScenarios.js");
      return await mod.default(req, res);
    }
    if (path === "/api/listings/bulk-set-sku") {
      const mod = await import("../src/handlers/listings/bulkSetSku.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/sync-sales") {
      const mod = await import("../src/handlers/ml/salesSync.js");
      return await mod.default(req, res);
    }
    if (path === "/api/ml/sales-summary") {
      const mod = await import("../src/handlers/ml/salesSummary.js");
      return await mod.default(req, res);
    }
    if (path === "/api/pricing/simulate") {
      const mod = await import("../src/handlers/pricing/simulate.js");
      return mod.default(req, res);
    }
    if (path === "/api/pricing/apply") {
      const mod = await import("../src/handlers/pricing/apply.js");
      return mod.default(req, res);
    }
    if (/^\/api\/products\/[^/]+\/performance$/.test(path)) {
      const mod = await import("../src/handlers/products/performance.js");
      const m = path.match(/^\/api\/products\/([^/]+)\/performance$/);
      req.params = { ...(req.params || {}), id: m?.[1] || null };
      return mod.handleProductsPerformance(req, res);
    }
    if (path === "/api/products/health") {
      const mod = await import("../src/handlers/products/health.js");
      return mod.handleProductsHealth(req, res);
    }
    if (path === "/api/products/upsert") {
      const mod = await import("../src/handlers/products/upsert.js");
      return mod.handleProductsUpsert(req, res);
    }
    if (path === "/api/products/for-edit") {
      const mod = await import("../src/handlers/products/getForEdit.js");
      return mod.handleProductsForEdit(req, res);
    }
    if (path === "/api/products/listings") {
      const mod = await import("../src/handlers/products/productListings.js");
      return mod.handleProductsListings(req, res);
    }
    if (path === "/api/products/change-status") {
      const mod = await import("../src/handlers/products/changeStatus.js");
      return mod.handleProductsChangeStatus(req, res);
    }
    if (path === "/api/products/ad-titles") {
      const mod = await import("../src/handlers/products/adTitles.js");
      return mod.handleProductsAdTitles(req, res);
    }
    if (path === "/api/products/catalog-rankings") {
      const mod = await import("../src/handlers/products/catalogRankings.js");
      return mod.handleProductsCatalogRankings(req, res);
    }
    if (path === "/api/jobs/stock-min-check") {
      const mod = await import("../src/handlers/jobs/stockMinCheck.js");
      return mod.handleJobsStockMinCheck(req, res);
    }
    if (path === "/api/images/seo-rename") {
      const mod = await import("../src/handlers/images/seoRename.js");
      return mod.handleImagesSeoRename(req, res);
    }
    if (path.startsWith("/api/dev-center")) {
      const mod = await import("../src/handlers/devCenter/index.js");
      return mod.handleDevCenter(req, res, path);
    }

    // ------------------------------
    // 404 padrão
    // ------------------------------
    console.warn("[S7 API Router] 404 path=", path, "rawUrl=", rawUrl);
    return res.status(404).json({
      ok: false,
      error: "Route not found",
      path,
      rawUrl,
      hint:
        "No Vercel, rewrites mapeiam /api/... → /api?__path=.... Teste também GET /api?__path=debug/ml/listing-cover-compare&a=MLBx&b=MLBy",
    });
  } catch (err) {
    // ------------------------------
    // FASE 4: JSON com errorId (não texto da Vercel)
    // ------------------------------
    const errorId = Date.now();
    console.error("[S7 API Router] errorId:", errorId, err);
    return res.status(500).json({
      ok: false,
      error: "Internal error",
      errorId,
    });
  }
}
