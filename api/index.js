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
    const url = new URL(req.url || "/api", baseUrl);
    const pathParam = url.searchParams.get("__path");
    const path = pathParam ? `/api/${pathParam}` : url.pathname;

    req.query = Object.fromEntries(url.searchParams);

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
    if (path === "/api/products/health") {
      const mod = await import("../src/handlers/products/health.js");
      return mod.handleProductsHealth(req, res);
    }
    if (path === "/api/products/upsert") {
      const mod = await import("../src/handlers/products/upsert.js");
      return mod.handleProductsUpsert(req, res);
    }
    if (path === "/api/products/change-status") {
      const mod = await import("../src/handlers/products/changeStatus.js");
      return mod.handleProductsChangeStatus(req, res);
    }
    if (path === "/api/products/ad-titles") {
      const mod = await import("../src/handlers/products/adTitles.js");
      return mod.handleProductsAdTitles(req, res);
    }
    if (path === "/api/jobs/stock-min-check") {
      const mod = await import("../src/handlers/jobs/stockMinCheck.js");
      return mod.handleJobsStockMinCheck(req, res);
    }
    if (path === "/api/images/seo-rename") {
      const mod = await import("../src/handlers/images/seoRename.js");
      return mod.handleImagesSeoRename(req, res);
    }

    // ------------------------------
    // 404 padrão
    // ------------------------------
    return res.status(404).json({
      ok: false,
      error: "Route not found",
      path,
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
