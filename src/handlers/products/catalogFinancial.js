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

  const startedAt = Date.now();
  const requestId = `cf_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  const perfLog = (label, payload = {}) => {
    console.info(`[S7_CATALOG_FINANCIAL_PERF] ${label}`, { request_id: requestId, ...payload });
  };
  perfLog("request_received", { method: req.method, path: "/api/products/catalog-financial" });

  const auth = await requireAuthUser(req);
  perfLog("auth_done", { elapsed_ms: Date.now() - startedAt, hasError: Boolean(auth.error) });
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({
        ok: true,
        source: "catalog-financial-lite-ssot",
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
  perfLog("request_context", { user_id: user?.id ?? null });

  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) {
    perfLog("premium_gate_blocked", { elapsed_ms: Date.now() - startedAt, user_id: user?.id ?? null });
    return;
  }

  try {
    const payload = await buildProductCatalogFinancial(supabase, user.id, { startedAt });
    perfLog("response_ready", {
      total_duration_ms: Date.now() - startedAt,
      by_product_rows: Object.keys(payload?.by_product_id ?? {}).length,
      ads_rows: Object.keys(payload?.ads_linked_count_by_product_id ?? {}).length,
      data_quality: payload?.data_quality?.status ?? null,
      products_count: payload?.diagnostics?.products_count ?? null,
      listings_count: payload?.diagnostics?.listings_count ?? null,
      sales_rows_count: payload?.diagnostics?.sales_rows_count ?? null,
      result_rows_count: payload?.diagnostics?.result_rows_count ?? null,
    });
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[Suse7][API][products/catalog-financial] failed", {
      message: error?.message,
      code: error?.code,
    });
    perfLog("response_error", {
      total_duration_ms: Date.now() - startedAt,
      message: error?.message ?? String(error),
      code: error?.code ?? null,
    });
    return res.status(200).json({
      ok: true,
      source: "catalog-financial-lite-ssot",
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
