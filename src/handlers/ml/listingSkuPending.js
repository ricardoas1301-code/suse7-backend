// ======================================================
// GET /api/ml/listings/sku-pending
// Lista anúncios do seller ainda sem product_id (pendentes de SKU).
// Reutiliza listSkuDependencyPendingForUser — sem regra nova de produto.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { listSkuDependencyPendingForUser } from "../../domain/listings/skuDependencyPending.js";

export default async function handleMlListingsSkuPending(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido." });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "anuncios" })) return;

  try {
    const result = await listSkuDependencyPendingForUser(supabase, user.id, {
      page: req.query?.page,
      pageSize: req.query?.page_size ?? req.query?.pageSize,
      q: req.query?.q,
    });
    const totalPages =
      result.total <= 0 ? 1 : Math.max(1, Math.ceil(result.total / result.page_size));
    return res.status(200).json({
      ok: true,
      items: result.items,
      total: result.total,
      page: result.page,
      page_size: result.page_size,
      total_pages: totalPages,
    });
  } catch (error) {
    console.error("[ml/listings/sku-pending] list_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ ok: false, error: "Não foi possível carregar os anúncios pendentes." });
  }
}
