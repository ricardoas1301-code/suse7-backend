import { ML_MARKETPLACE_SLUG } from "../../../../handlers/ml/_helpers/mlMarketplace.js";
import { fetchMercadoLibreUserById } from "../../../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { persistMercadoLibreOrder } from "../../../../handlers/ml/_helpers/mlSalesPersist.js";
import { extractBuyerThumbFromOrderRaw } from "../../../../handlers/sales/_vendasSalesRows.js";
import { enrichMercadoLivreSaleFinancialSnapshot } from "../../../../services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

function isColumnError(error) {
  return (
    String(error?.code ?? "") === "42703" ||
    String(error?.message ?? "").toLowerCase().includes("column")
  );
}

/**
 * GET /orders/:id muitas vezes não traz foto do comprador no `buyer`; o GET /users/:id costuma incluir `thumbnail`.
 * @param {Record<string, unknown>} order
 * @param {string} accessToken
 * @param {{ marketplaceAccountId?: string | null }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function enrichMlOrderBuyerThumbnailIfNeeded(order, accessToken, options = {}) {
  if (!order || typeof order !== "object") return order;
  if (!accessToken || String(accessToken).trim() === "") return order;
  if (extractBuyerThumbFromOrderRaw(order)) return order;
  const buyer = order.buyer && typeof order.buyer === "object" ? /** @type {Record<string, unknown>} */ (order.buyer) : null;
  const bid = buyer?.id != null ? String(buyer.id).trim() : "";
  if (!bid) return order;
  try {
    const profile = await fetchMercadoLibreUserById(accessToken, bid, options);
    if (!profile || typeof profile !== "object") return order;
    const p = /** @type {Record<string, unknown>} */ (profile);
    const merged = { ...buyer };
    for (const k of ["thumbnail", "secure_thumbnail", "picture", "photo"]) {
      if (p[k] != null && merged[k] == null) merged[k] = p[k];
    }
    if (!extractBuyerThumbFromOrderRaw({ ...order, buyer: merged })) return order;
    return { ...order, buyer: merged };
  } catch {
    return order;
  }
}

async function applyOrderScopeColumns(supabase, salesOrderId, marketplaceAccountId, sellerCompanyId) {
  if (!salesOrderId) return;
  const scopePatches = [
    {
      sales_orders: {
        marketplace_account_id: marketplaceAccountId || null,
        seller_company_id: sellerCompanyId || null,
      },
      sales_order_items: {
        marketplace_account_id: marketplaceAccountId || null,
        seller_company_id: sellerCompanyId || null,
      },
    },
    {
      sales_orders: { marketplace_account_id: marketplaceAccountId || null },
      sales_order_items: { marketplace_account_id: marketplaceAccountId || null },
    },
    {
      sales_orders: { seller_company_id: sellerCompanyId || null },
      sales_order_items: { seller_company_id: sellerCompanyId || null },
    },
  ];

  for (const patch of scopePatches) {
    const { error: oErr } = await supabase
      .from("sales_orders")
      .update(patch.sales_orders)
      .eq("id", salesOrderId);
    if (oErr && !isColumnError(oErr)) throw oErr;
    if (oErr) continue;

    const { error: iErr } = await supabase
      .from("sales_order_items")
      .update(patch.sales_order_items)
      .eq("sales_order_id", salesOrderId);
    if (iErr && !isColumnError(iErr)) throw iErr;
    return;
  }
}

/**
 * Aplica um pedido ML no storage transacional de vendas do Suse7.
 * Mantém idempotência por (marketplace, marketplace_account_id, external_order_id) e tenta anexar escopo
 * de conta/empresa quando colunas já existem no schema.
 */
export async function applyMlOrderDetailToMarketplaceSales(
  supabase,
  userId,
  marketplaceAccountId,
  sellerCompanyId,
  orderDetail,
  nowIso,
  summary,
  accessToken,
  traceCtx = {}
) {
  void nowIso;

  const extOrderId = orderDetail?.id != null ? String(orderDetail.id) : null;
  const logStep = (step, extra = {}) => {
    console.info("[S7][ml-sales-sync-order-step]", {
      syncRunId: traceCtx.syncRunId ?? null,
      marketplaceAccountId,
      sellerCompanyId,
      externalOrderId: extOrderId,
      index: traceCtx.orderIndex ?? null,
      total: traceCtx.total ?? null,
      step,
      ...extra,
    });
  };
  if (!extOrderId) {
    summary.errors.push("order_without_id");
    summary.skipped_count += 1;
    return { ok: false, reason: "order_without_id" };
  }

  if (!marketplaceAccountId || String(marketplaceAccountId).trim() === "") {
    summary.errors.push("missing_marketplace_account_id");
    summary.skipped_count += 1;
    return { ok: false, reason: "missing_marketplace_account_id" };
  }

  const existingQuery = supabase
    .from("sales_orders")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("marketplace_account_id", marketplaceAccountId)
    .eq("external_order_id", extOrderId);
  const { data: existing, error: exErr } = await existingQuery.maybeSingle();
  if (exErr) throw exErr;

  logStep("enrich buyer thumbnail");
  const orderForPersist = await enrichMlOrderBuyerThumbnailIfNeeded(
    /** @type {Record<string, unknown>} */ (orderDetail),
    accessToken,
    { marketplaceAccountId: marketplaceAccountId || null }
  );

  logStep("persist order");
  const out = await persistMercadoLibreOrder(supabase, userId, orderForPersist, {
    marketplace: ML_MARKETPLACE_SLUG,
    marketplaceAccountId: marketplaceAccountId || null,
    sellerCompanyId: sellerCompanyId || null,
    traceCtx,
    log: (msg, extra) => {
      console.log("[Suse7][API][ml-sales-apply]", msg, extra ?? {});
    },
  });
  logStep("persist items");

  if (accessToken && String(accessToken).trim() !== "" && out?.salesOrderId) {
    logStep("enrich financial snapshot");
    try {
      await enrichMercadoLivreSaleFinancialSnapshot(supabase, userId, orderForPersist, {
        accessToken: String(accessToken).trim(),
        marketplaceAccountId: marketplaceAccountId || null,
        salesOrderId: String(out.salesOrderId),
        logContext: "ml_sales_sync",
      });
    } catch (enrichErr) {
      console.warn("[Suse7][API][ml-sales-apply] financial_enrichment_failed", {
        message: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
        external_order_id: extOrderId,
      });
    }
  }

  logStep("persist customer");
  await applyOrderScopeColumns(
    supabase,
    out?.salesOrderId ?? existing?.id ?? null,
    marketplaceAccountId,
    sellerCompanyId
  );
  logStep("snapshot");
  logStep("metrics");

  summary.synced_count += 1;
  if (existing?.id) summary.updated_count += 1;
  else summary.created_count += 1;

  return { ok: true, salesOrderId: out?.salesOrderId ?? existing?.id ?? null };
}

