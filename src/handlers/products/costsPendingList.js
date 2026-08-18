// ======================================================================
// GET /api/products/costs/pending — produtos com custos incompletos (paginado)
// Unidade: product_id (deduplicado na origem products)
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { listPendingProductCosts } from "../../domain/products/productCostsPendingRepository.js";

export async function handleProductsCostsPendingList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const page = parseInt(String(req.query?.page ?? "1"), 10);
  const pageSize = parseInt(String(req.query?.page_size ?? "25"), 10);
  const q = req.query?.q != null ? String(req.query.q) : undefined;

  const result = await listPendingProductCosts(supabase, user.id, { page, pageSize, q });
  if (!result.ok) {
    return res.status(500).json({ ok: false, error: result.error || "Erro ao listar produtos pendentes" });
  }

  return res.status(200).json({
    ok: true,
    items: result.items,
    page: result.page,
    page_size: result.page_size,
    total: result.total,
    total_pages: result.total_pages,
  });
}
