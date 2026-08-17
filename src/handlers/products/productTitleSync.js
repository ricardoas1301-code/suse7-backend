// ======================================================================
// GET/POST /api/products/:productId/titles/sync-listings
// Sincronização de título do produto → anúncios vinculados.
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  listProductTitleSyncCandidates,
  syncProductTitleToListings,
} from "../../domain/products/productTitleSyncService.js";

/**
 * @param {import("http").IncomingMessage} req
 */
function resolveProductIdFromPath(req) {
  const rawPath = String(req.url ?? "").split("?")[0];
  const m = rawPath.match(/\/api\/products\/([^/]+)\/titles\/sync-listings\/?$/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export default async function handleProductTitleSync(req, res) {
  const productId = resolveProductIdFromPath(req);
  if (!productId) {
    return res.status(400).json({ ok: false, error: "product_id inválido na rota." });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  if (req.method === "GET") {
    const payload = await listProductTitleSyncCandidates(supabase, user.id, productId);
    if (!payload.ok) {
      return res.status(400).json({ ok: false, error: payload.error, listings: [] });
    }
    return res.status(200).json({ ok: true, listings: payload.listings });
  }

  if (req.method === "POST") {
    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    } catch {
      return res.status(400).json({ ok: false, error: "JSON inválido." });
    }

    const title = body.title != null ? String(body.title) : "";
    const listingIds = Array.isArray(body.listing_ids) ? body.listing_ids : [];
    const syncMarketplace = body.sync_marketplace !== false;

    const payload = await syncProductTitleToListings(supabase, user.id, productId, {
      title,
      listingIds,
      syncMarketplace,
    });

    if (!payload.ok) {
      return res.status(400).json({ ok: false, error: payload.error });
    }

    return res.status(200).json({
      success: payload.success,
      summary: payload.summary,
      results: payload.results,
    });
  }

  return res.status(405).json({ ok: false, error: "Método não permitido" });
}
