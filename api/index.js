// ==================================================
// SUSE7 — API ROUTER ÚNICO (Vercel Hobby Limit Fix)
// Arquivo: api/index.js
//
// Objetivo:
// - Evitar limite de 12 Serverless Functions no plano Hobby
// - Roteamento interno por URL (1 única função /api)
// - CORS centralizado
// ==================================================

import { applyCors } from "../src/middlewares/cors.js";

// ------------------------------
// Importa handlers internos
// ------------------------------
import { handleUserPreferences } from "../src/handlers/user/preferences.js";
import { handleUserPreferencesReset } from "../src/handlers/user/preferencesReset.js";
import { handleNotifications } from "../src/handlers/notifications/index.js";
import { handleNotificationsMarkRead } from "../src/handlers/notifications/markRead.js";
import { handleDraftsUpsert } from "../src/handlers/drafts/upsert.js";

// ML
import { handleMlConnect } from "../src/handlers/ml/connect.js";
import { handleMlCallback } from "../src/handlers/ml/callback.js";
import { handleMlStatus } from "../src/handlers/ml/status.js";

// Products
import { handleProductsHealth } from "../src/handlers/products/health.js";
import { handleProductsUpsert } from "../src/handlers/products/upsert.js";
import { handleProductsChangeStatus } from "../src/handlers/products/changeStatus.js";
import { handleProductsAdTitles } from "../src/handlers/products/adTitles.js";

// Jobs / Images
import { handleJobsStockMinCheck } from "../src/handlers/jobs/stockMinCheck.js";
import { handleImagesSeoRename } from "../src/handlers/images/seoRename.js";

// ==================================================
// Router
// ==================================================
export default async function handler(req, res) {
  // ------------------------------
  // CORS + preflight
  // ------------------------------
  const finished = applyCors(req, res);
  if (finished) return;

  // ------------------------------
  // Normaliza path e query
  // req.url: /api?__path=products/health&product_id=123 (após rewrite)
  // ou req.url: /api/products/health?product_id=123 (sem rewrite)
  // ------------------------------
  const baseUrl = `http://${req.headers?.host || "localhost"}`;
  const url = new URL(req.url || "/api", baseUrl);
  const pathParam = url.searchParams.get("__path");
  const path = pathParam ? `/api/${pathParam}` : url.pathname;

  // Popula req.query para handlers que usam query params
  req.query = Object.fromEntries(url.searchParams);

  try {
    // ------------------------------
    // Rotas (match exato)
    // ------------------------------
    if (path === "/api/user/preferences") return handleUserPreferences(req, res);
    if (path === "/api/user/preferences/reset") return handleUserPreferencesReset(req, res);
    if (path === "/api/notifications") return handleNotifications(req, res);
    if (path === "/api/notifications/mark-read") return handleNotificationsMarkRead(req, res);

    if (path === "/api/drafts/upsert") return handleDraftsUpsert(req, res);

    if (path === "/api/ml/connect") return handleMlConnect(req, res);
    if (path === "/api/ml/callback") return handleMlCallback(req, res);
    if (path === "/api/ml/status") return handleMlStatus(req, res);

    if (path === "/api/products/health") return handleProductsHealth(req, res);
    if (path === "/api/products/upsert") return handleProductsUpsert(req, res);
    if (path === "/api/products/change-status") return handleProductsChangeStatus(req, res);
    if (path === "/api/products/ad-titles") return handleProductsAdTitles(req, res);

    if (path === "/api/jobs/stock-min-check") return handleJobsStockMinCheck(req, res);
    if (path === "/api/images/seo-rename") return handleImagesSeoRename(req, res);

    // ------------------------------
    // 404 padrão
    // ------------------------------
    return res.status(404).json({
      ok: false,
      error: "Route not found",
      path,
    });
  } catch (err) {
    console.error("[S7 API Router] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
}
