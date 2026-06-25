// ======================================================================
// GET /api/products/catalog-financial
// Alimentação SSOT da listagem de Produtos (histórico consolidado).
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { buildProductCatalogFinancial } from "../../domain/products/buildProductCatalogFinancial.js";

export async function handleProductsCatalogFinancial(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({
        ok: true,
        source: "executive-summary-ssot",
        period: { preset: "lifetime", start_date: null, end_date: null },
        by_product_id: {},
        ads_linked_count_by_product_id: {},
        data_quality: { status: "partial", warnings: ["Configuração indisponível."] },
        truncated_scan: false,
      });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) return;

  try {
    const payload = await buildProductCatalogFinancial(supabase, user.id);
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[Suse7][API][products/catalog-financial] failed", {
      message: error?.message,
      code: error?.code,
    });
    return res.status(200).json({
      ok: true,
      source: "executive-summary-ssot",
      period: { preset: "lifetime", start_date: null, end_date: null },
      by_product_id: {},
      ads_linked_count_by_product_id: {},
      data_quality: {
        status: "partial",
        warnings: [
          error?.message != null && String(error.message).trim() !== ""
            ? String(error.message)
            : "Falha ao carregar métricas financeiras do catálogo.",
        ],
      },
      truncated_scan: false,
    });
  }
}
