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
import handleMlWebhookRoute from "../src/handlers/ml/mlWebhookRoutes.js";

const DEBUG_ML_FIELD_MAP_PATH = "/api/debug/marketplaces/mercado-livre/listings/field-map";
const DEBUG_ML_COVER_COMPARE_PATH = "/api/debug/ml/listing-cover-compare";
const DEBUG_ML_LISTINGS_COVER_CONTEXT_PATH = "/api/debug/ml/listings-cover-context";
console.log("[S7 API Router] boot — rotas diagnóstico ML:", DEBUG_ML_FIELD_MAP_PATH, DEBUG_ML_COVER_COMPARE_PATH, DEBUG_ML_LISTINGS_COVER_CONTEXT_PATH);
console.log("[S7 API Router] boot — ML OAuth diag: GET /api/ml/oauth-config");
console.log("[S7 API Router] boot — billing: GET /api/billing/ping · GET /api/billing/plans · POST /api/billing/checkout/card · POST /api/billing/checkout/start · GET /api/billing/webhooks/asaas/health · POST /api/billing/webhooks/asaas · POST /api/jobs/billing-renewal-engine · POST /api/jobs/billing-consistency-check · POST /api/billing/renewals/:id/pay");
console.log("[S7 API Router] boot — notifications: POST /api/jobs/daily-sales-summary-automation");

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

/**
 * Match robusto para POST via __path (encoding/case) ou pathname direto.
 * @param {string} rawUrl
 */
function rawUrlLooksLikeMarketplaceAccountSyncJob(rawUrl) {
  const r = String(rawUrl || "");
  if (
    r.includes("__path=jobs%2Fmarketplace-account-sync") ||
    r.includes("__path=jobs%2fmarketplace-account-sync") ||
    r.includes("__path=jobs/marketplace-account-sync") ||
    r.includes("&__path=jobs%2Fmarketplace-account-sync") ||
    r.includes("&__path=jobs%2fmarketplace-account-sync") ||
    r.includes("&__path=jobs/marketplace-account-sync") ||
    r.includes("/jobs/marketplace-account-sync")
  ) {
    return true;
  }
  try {
    const dec = decodeURIComponent(r);
    return dec.includes("__path=jobs/marketplace-account-sync") || dec.includes("jobs/marketplace-account-sync");
  } catch {
    return false;
  }
}

/**
 * Path já normalizado pelo router (sem query).
 * @param {string} pathname
 */
function isMarketplaceAccountSyncResolvedPath(pathname) {
  const p = String(pathname || "").replace(/\/+$/, "") || "/";
  return (
    p === "/api/jobs/marketplace-account-sync" ||
    p === "/jobs/marketplace-account-sync" ||
    p.endsWith("/jobs/marketplace-account-sync")
  );
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
    const methodUpper = String(req.method || "GET").toUpperCase();

    // ------------------------------
    // ML ingest webhook — PRIMEIRO (antes de qualquer outro roteamento).
    // Vercel: rawUrl pode ser /api/ml/webhook?__path=...; evitar substring "ml/webhook" (colide com ml-webhook-events).
    // ------------------------------
    {
      const rawLower = String(rawUrl || "").toLowerCase();
      const pathResolvedEarly = resolveRouterPath(rawUrl, baseUrl);
      const pathNormEarly =
        String(pathResolvedEarly || "")
          .replace(/\/+$/, "")
          .replace(/\/{2,}/g, "/") || "/";
      const isMlWebhookEventsJob =
        rawLower.includes("ml-webhook-events") ||
        rawLower.includes("jobs%2fml-webhook-events") ||
        rawLower.includes("jobs/ml-webhook-events");
      const pathMatchIngest =
        pathNormEarly === "/api/ml/webhook" ||
        pathNormEarly === "/ml/webhook" ||
        pathNormEarly === "/api/ml/webhooks" ||
        pathNormEarly === "/ml/webhooks";
      const rawMatchIngest =
        rawLower.includes("/api/ml/webhook") ||
        rawLower.includes("/api/ml/webhooks") ||
        rawLower.includes("/ml/webhook") ||
        rawLower.includes("/ml/webhooks") ||
        rawLower.includes("__path=ml%2fwebhook") ||
        rawLower.includes("__path=ml%2Fwebhook") ||
        rawLower.includes("__path=api%2fml%2fwebhook") ||
        rawLower.includes("__path=api%2Fml%2Fwebhook") ||
        rawLower.includes("__path=ml/webhook") ||
        rawLower.includes("__path=api/ml/webhook");
      if (!isMlWebhookEventsJob && (pathMatchIngest || rawMatchIngest)) {
        console.info("[ml/webhook] route_matched", {
          pathNorm: pathNormEarly,
          pathResolved: pathResolvedEarly,
          rawUrl,
          method: methodUpper,
        });
        return await handleMlWebhookRoute(req, res);
      }
    }

    // ------------------------------
    // HOTFIX — Job ML Webhook Events
    // Bypass pelo rawUrl para evitar falha de match no router único Vercel.
    // ------------------------------
    if (
      rawUrl.includes("__path=jobs%2Fml-webhook-events") ||
      rawUrl.includes("__path=jobs/ml-webhook-events") ||
      rawUrl.includes("/jobs/ml-webhook-events")
    ) {
      console.log("[S7 API Router] HOTFIX matched ML webhook events job", {
        rawUrl,
        method: req.method,
        router_version: "ml-webhook-job-rawurl-hotfix-v1",
      });

      const mod = await import("../src/handlers/jobs/mlWebhookEventsJob.js");
      return mod.handleJobsMlWebhookEvents(req, res);
    }

    // ------------------------------
    // HOTFIX — Marketplace Account Sync Job (mesmo padrão do webhook ML)
    // ------------------------------
    if (rawUrlLooksLikeMarketplaceAccountSyncJob(rawUrl)) {
      console.log("[S7 API Router] matched marketplace account sync job", {
        path: "(rawUrl-hotfix)",
        rawUrl,
        method: req.method,
        router_version: "marketplace-account-sync-rawurl-hotfix-v1",
      });

      try {
        const mod = await import("../src/handlers/jobs/marketplaceAccountSyncJob.js");
        return await mod.handleJobsMarketplaceAccountSync(req, res);
      } catch (syncRouteErr) {
        console.error("[S7 API Router] marketplace-account-sync route failed", {
          phase: "import_or_handler",
          message: syncRouteErr?.message ?? String(syncRouteErr),
          name: syncRouteErr?.name ?? null,
          code: syncRouteErr?.code ?? null,
          stack: syncRouteErr?.stack ?? null,
        });
        throw syncRouteErr;
      }
    }

    const url = new URL(rawUrl, baseUrl);
    const path = resolveRouterPath(rawUrl, baseUrl);
    const pathNorm = String(path || "")
      .replace(/\/+$/, "")
      .replace(/\/{2,}/g, "/") || "/";

    console.log("[S7 API Router] resolved path", {
      path,
      pathNorm,
      rawUrl,
      method: req.method,
      router_version: "ml-webhook-job-top-route-v1",
    });

    if (path === "/api/debug/router-version") {
      return res.status(200).json({
        ok: true,
        router_version: "ml-webhook-job-top-route-v1",
        path,
        rawUrl,
        timestamp: new Date().toISOString(),
      });
    }

    if (
      path === "/api/jobs/ml-webhook-events" ||
      path === "/jobs/ml-webhook-events" ||
      path.endsWith("/jobs/ml-webhook-events")
    ) {
      console.log("[S7 API Router] matched ML webhook events job", {
        path,
        rawUrl,
        method: req.method,
        router_version: "ml-webhook-job-top-route-v1",
      });

      const mod = await import("../src/handlers/jobs/mlWebhookEventsJob.js");
      return mod.handleJobsMlWebhookEvents(req, res);
    }

    if (isMarketplaceAccountSyncResolvedPath(path)) {
      console.log("[S7 API Router] matched marketplace account sync job", {
        path,
        rawUrl,
        method: req.method,
        router_version: "marketplace-account-sync-route-v1",
      });

      try {
        const mod = await import("../src/handlers/jobs/marketplaceAccountSyncJob.js");
        return await mod.handleJobsMarketplaceAccountSync(req, res);
      } catch (syncRouteErr) {
        console.error("[S7 API Router] marketplace-account-sync route failed", {
          phase: "import_or_handler",
          message: syncRouteErr?.message ?? String(syncRouteErr),
          name: syncRouteErr?.name ?? null,
          code: syncRouteErr?.code ?? null,
          stack: syncRouteErr?.stack ?? null,
        });
        throw syncRouteErr;
      }
    }

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

    if (path === "/api/public/fale-conosco/contact" && req.method === "POST") {
      const mod = await import("../src/handlers/public/faleConoscoContactApi.js");
      return mod.handleFaleConoscoContact(req, res);
    }

    // ------------------------------
    // Billing — cedo no router (path + pathNorm + rawUrl; evita 404 se divergir normalização)
    // ------------------------------
    if (
      pathNorm.startsWith("/api/billing") ||
      path.startsWith("/api/billing") ||
      /(?:^|[?&])__path=(?:api%2F|api%2f)?billing/i.test(String(rawUrl || "")) ||
      /(?:^|[?&])__path=billing\//i.test(String(rawUrl || "")) ||
      /\/api\/billing/i.test(String(rawUrl || ""))
    ) {
      const billingPath =
        String(pathNorm && pathNorm !== "/" ? pathNorm : path || "")
          .replace(/\/+$/, "")
          .replace(/\/{2,}/g, "/") || "/";
      const mod = await import("../src/billing/routes/billingRoutes.js");
      return mod.handleBillingRoutes(req, res, billingPath);
    }

    // ------------------------------
    // Rotas (lazy import — FASE 2)
    // ------------------------------
    if (path === "/api/user/profile-summary" && req.method === "GET") {
      const mod = await import("../src/handlers/user/profileSummary.js");
      return mod.handleUserProfileSummary(req, res);
    }
    if (path === "/api/user/preferences") {
      const mod = await import("../src/handlers/user/preferences.js");
      return mod.handleUserPreferences(req, res);
    }
    if (path === "/api/user/preferences/reset") {
      const mod = await import("../src/handlers/user/preferencesReset.js");
      return mod.handleUserPreferencesReset(req, res);
    }
    if (path === "/api/internal/notifications/email/process") {
      const mod = await import("../src/handlers/notifications/processEmailOutboxApi.js");
      return mod.handleProcessEmailOutbox(req, res);
    }
    if (path === "/api/internal/notifications/whatsapp/process") {
      const mod = await import("../src/handlers/notifications/processWhatsAppOutboxApi.js");
      return mod.handleProcessWhatsAppOutbox(req, res);
    }
    if (
      path === "/api/notifications/inbox" ||
      path === "/api/notifications/inbox/read-all" ||
      /^\/api\/notifications\/inbox\/[^/]+\/read$/.test(path)
    ) {
      const mod = await import("../src/handlers/notifications/sellerNotificationInboxApi.js");
      return mod.handleNotificationInboxRoutes(req, res, path);
    }
    if (path === "/api/notifications/manual/sale-rayx" && req.method === "POST") {
      const mod = await import("../src/handlers/notifications/saleRayxManualNotificationApi.js");
      return mod.handleSaleRayxManualNotification(req, res);
    }
    if (path === "/api/notifications/manual/sales-report" && req.method === "POST") {
      const mod = await import("../src/handlers/notifications/salesReportManualNotificationApi.js");
      return mod.handleSalesReportManualNotification(req, res);
    }
    if (path === "/api/notifications/categories" && req.method === "GET") {
      const mod = await import("../src/handlers/notifications/sellerNotificationSellerApi.js");
      return mod.handleNotificationSellerCategories(req, res);
    }
    if (path === "/api/notifications/preferences" && (req.method === "GET" || req.method === "PATCH")) {
      const mod = await import("../src/handlers/notifications/sellerNotificationSellerApi.js");
      return mod.handleNotificationSellerPreferences(req, res);
    }
    if (
      path === "/api/notifications/event-delivery-rules" &&
      (req.method === "GET" || req.method === "PATCH")
    ) {
      const mod = await import("../src/handlers/notifications/sellerNotificationSellerApi.js");
      return mod.handleNotificationSellerEventDeliveryRules(req, res);
    }
    if (
      path === "/api/notifications/automation-rules/daily-sales-summary" &&
      (req.method === "GET" || req.method === "PATCH")
    ) {
      const mod = await import("../src/handlers/notifications/sellerNotificationSellerApi.js");
      return mod.handleNotificationSellerDailySalesSummaryAutomation(req, res);
    }
    if (
      (path === "/api/notifications/recipients" && (req.method === "GET" || req.method === "POST")) ||
      /^\/api\/notifications\/recipients\/[^/]+$/.test(path)
    ) {
      const mod = await import("../src/handlers/notifications/sellerNotificationSellerApi.js");
      return mod.handleNotificationSellerRecipients(req, res, path);
    }
    if (path === "/api/notifications") {
      const mod = await import("../src/handlers/notifications/index.js");
      return mod.handleNotifications(req, res);
    }
    if (path === "/api/notifications/mark-read") {
      const mod = await import("../src/handlers/notifications/markRead.js");
      return mod.handleNotificationsMarkRead(req, res);
    }
    if (path === "/api/notifications/contacts" && (req.method === "GET" || req.method === "POST")) {
      const mod = await import("../src/handlers/notifications/notificationContacts.js");
      return mod.handleNotificationContacts(req, res);
    }
    if (/^\/api\/notifications\/contacts\/[^/]+$/.test(path)) {
      const mod = await import("../src/handlers/notifications/notificationContacts.js");
      return mod.handleNotificationContactById(req, res, path);
    }
    if (path === "/api/notifications/routing-rules" && (req.method === "GET" || req.method === "PUT")) {
      const mod = await import("../src/handlers/notifications/notificationRoutingRules.js");
      return mod.handleNotificationRoutingRules(req, res);
    }
    if (path === "/api/notifications/debug/resolve" && req.method === "GET") {
      const mod = await import("../src/handlers/notifications/debugResolve.js");
      return mod.handleNotificationsDebugResolve(req, res);
    }
    if (path === "/api/notifications/routing-summary" && req.method === "GET") {
      const mod = await import("../src/handlers/notifications/notificationRoutingSummary.js");
      return mod.handleNotificationRoutingSummary(req, res);
    }
    if (path === "/api/notifications/debug/simulate" && req.method === "POST") {
      const mod = await import("../src/handlers/notifications/notificationDebugSimulate.js");
      return mod.handleNotificationDebugSimulate(req, res);
    }
    if (/^\/api\/notifications\/deliveries\/[^/]+\/retry$/.test(path) && req.method === "POST") {
      const mod = await import("../src/handlers/notifications/notificationDeliveryRetry.js");
      return mod.handleNotificationDeliveryRetry(req, res, path);
    }
    if (/^\/api\/notifications\/deliveries\/[^/]+\/cancel$/.test(path) && req.method === "POST") {
      const mod = await import("../src/handlers/notifications/notificationDeliveryCancel.js");
      return mod.handleNotificationDeliveryCancel(req, res, path);
    }
    if (path === "/api/notifications/deliveries" && req.method === "GET") {
      const mod = await import("../src/handlers/notifications/notificationDeliveriesList.js");
      return mod.handleNotificationDeliveriesList(req, res);
    }
    if (path === "/api/notifications/events" && req.method === "GET") {
      const mod = await import("../src/handlers/notifications/notificationEventsList.js");
      return mod.handleNotificationEventsList(req, res);
    }
    if (/^\/api\/notifications\/events\/[^/]+$/.test(path) && req.method === "GET") {
      const mod = await import("../src/handlers/notifications/notificationEventDetail.js");
      return mod.handleNotificationEventDetail(req, res, path);
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
    if (path === "/api/ml/listings/pricing-simulate-scenario" && req.method === "POST") {
      const mod = await import("../src/handlers/ml/listingPricingSimulateScenario.js");
      return await mod.default(req, res);
    }
    if (
      path === "/api/ml/listings/pricing-simulation-config" &&
      (req.method === "GET" || req.method === "POST")
    ) {
      const mod = await import("../src/handlers/ml/listingPricingSimulationConfig.js");
      return await mod.default(req, res);
    }
    /** Alias histórico: mesmo handler que `pricing-scenarios` (contrato canônico no FE). */
    if (path === "/api/ml/listings/sale-xray-modal") {
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
    if (path === "/api/sales/detail" && req.method === "GET") {
      const mod = await import("../src/handlers/sales/detail.js");
      return mod.default(req, res);
    }
    if (path === "/api/sales" && req.method === "GET") {
      const mod = await import("../src/handlers/sales/list.js");
      return mod.default(req, res);
    }
    if (path === "/api/sales/executive-summary" && req.method === "GET") {
      const mod = await import("../src/handlers/sales/executiveSummary.js");
      return mod.default(req, res);
    }
    if (path === "/api/sales/summary" && req.method === "GET") {
      const mod = await import("../src/handlers/sales/summary.js");
      return mod.default(req, res);
    }
    if (
      (path === "/api/dev/sales/refresh-financial-contracts" ||
        /^\/api\/dev\/sales\/[^/]+\/refresh-financial-contract$/.test(path)) &&
      req.method === "POST"
    ) {
      const mod = await import("../src/handlers/sales/saleFinancialContractRefresh.js");
      return mod.handleSaleFinancialContractRefresh(req, res, path);
    }
    if (path === "/api/pricing/simulate") {
      const mod = await import("../src/handlers/pricing/simulate.js");
      return mod.default(req, res);
    }
    const pricingFinancialSettingsMatch = path.match(
      /^\/api\/pricing\/intelligent\/([^/]+)\/financial-settings$/,
    );
    if (
      pricingFinancialSettingsMatch &&
      (req.method === "PATCH" || req.method === "GET")
    ) {
      req.params = { listing_id: pricingFinancialSettingsMatch[1] };
      const mod = await import("../src/handlers/pricing/intelligentFinancialSettings.js");
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
    if (path === "/api/jobs/process-notification-deliveries") {
      const mod = await import("../src/handlers/jobs/processNotificationDeliveriesJob.js");
      return mod.handleJobsProcessNotificationDeliveries(req, res);
    }
    if (path === "/api/jobs/daily-sales-summary-automation") {
      const mod = await import("../src/handlers/jobs/dailySalesSummaryAutomationJob.js");
      return mod.handleJobsDailySalesSummaryAutomation(req, res);
    }
    if (path === "/api/jobs/billing-process-period-expirations") {
      const mod = await import("../src/handlers/jobs/billingPeriodExpirationsJob.js");
      return mod.handleJobsBillingProcessPeriodExpirations(req, res);
    }
    if (path === "/api/jobs/billing-process-overdues") {
      const mod = await import("../src/handlers/jobs/billingOverduesJob.js");
      return mod.handleJobsBillingProcessOverdues(req, res);
    }
    if (path === "/api/jobs/billing-process-renewals") {
      const mod = await import("../src/handlers/jobs/billingRenewalsJob.js");
      return mod.handleJobsBillingProcessRenewals(req, res);
    }
    if (path === "/api/jobs/billing-renewal-engine") {
      const mod = await import("../src/handlers/jobs/billingRenewalEngineJob.js");
      return mod.handleJobsBillingRenewalEngine(req, res);
    }
    if (path === "/api/jobs/billing-consistency-check") {
      const mod = await import("../src/handlers/jobs/billingConsistencyCheckJob.js");
      return mod.handleJobsBillingConsistencyCheck(req, res);
    }
    if (path === "/api/images/seo-rename") {
      const mod = await import("../src/handlers/images/seoRename.js");
      return mod.handleImagesSeoRename(req, res);
    }
    if (path.startsWith("/api/dev-center")) {
      const mod = await import("../src/handlers/devCenter/index.js");
      return mod.handleDevCenter(req, res, path);
    }

    if (/^\/api\/seller\/companies\/[^/]+$/.test(path) && req.method === "GET") {
      const m = path.match(/^\/api\/seller\/companies\/([^/]+)$/);
      req.params = { ...(req.params || {}), companyId: m?.[1] || null };
      const mod = await import("../src/handlers/seller/companies.js");
      return mod.default(req, res);
    }
    if (path === "/api/seller/companies" && (req.method === "GET" || req.method === "POST")) {
      const mod = await import("../src/handlers/seller/companies.js");
      return mod.default(req, res);
    }
    if (/^\/api\/seller\/companies\/[^/]+$/.test(path) && req.method === "PATCH") {
      const m = path.match(/^\/api\/seller\/companies\/([^/]+)$/);
      req.params = { ...(req.params || {}), companyId: m?.[1] || null };
      const mod = await import("../src/handlers/seller/companies.js");
      return mod.default(req, res);
    }
    if (path === "/api/marketplace/accounts" && req.method === "GET") {
      const mod = await import("../src/handlers/marketplace/accounts.js");
      return mod.default(req, res);
    }
    if (path === "/api/marketplace/import-intelligence" && req.method === "GET") {
      const mod = await import("../src/handlers/marketplace/importIntelligenceSummary.js");
      return mod.default(req, res);
    }
    // S_4.6.2 — domínio seller (JWT user scope). Não confundir com /api/dev-center/customers-global.
    if (path === "/api/customers" && req.method === "GET") {
      const mod = await import("../src/handlers/customers/list.js");
      return mod.default(req, res);
    }
    if (/^\/api\/customers\/[^/]+$/.test(path) && req.method === "GET") {
      const m = path.match(/^\/api\/customers\/([^/]+)$/);
      req.params = { ...(req.params || {}), customerId: m?.[1] || null };
      const mod = await import("../src/handlers/customers/detail.js");
      return mod.default(req, res);
    }
    if (/^\/api\/marketplace\/accounts\/[^/]+\/start-initial-sync$/.test(path) && req.method === "POST") {
      const mod = await import("../src/handlers/marketplace/accountStartInitialSync.js");
      return mod.default(req, res, path);
    }
    if (/^\/api\/marketplace\/accounts\/[^/]+\/sync-status$/.test(path) && req.method === "GET") {
      const mod = await import("../src/handlers/marketplace/accountSyncStatus.js");
      return mod.default(req, res, path);
    }
    if (/^\/api\/marketplace\/accounts\/[^/]+$/.test(path) && (req.method === "PATCH" || req.method === "DELETE")) {
      const mod = await import("../src/handlers/marketplace/accountById.js");
      return mod.default(req, res, path);
    }

    // Concorrência Inteligente: roteamento interno fica no handler
    // (products, products/:id/competitors, competitors/:id, discover, + rotas legadas).
    if (path === "/api/competition" || path.startsWith("/api/competition/")) {
      console.info("[S7_COMPETITION_AUDIT_BOOT]", {
        module: "api_index_competition_gate",
        path,
        node_env: process.env.NODE_ENV ?? null,
        vercel_env: process.env.VERCEL_ENV ?? null,
        vercel_url: process.env.VERCEL_URL ?? null,
        sales_audit_flag: process.env.S7_COMPETITION_SALES_AUDIT ?? null,
        at: new Date().toISOString(),
      });
      const mod = await import("../src/handlers/competition/index.js");
      return mod.default(req, res, path);
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
