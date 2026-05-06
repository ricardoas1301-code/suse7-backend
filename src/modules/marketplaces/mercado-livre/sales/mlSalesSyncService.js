import { ML_MARKETPLACE_SLUG } from "../../../../handlers/ml/_helpers/mlMarketplace.js";
import { persistMercadoLibreOrder } from "../../../../handlers/ml/_helpers/mlSalesPersist.js";

function isColumnError(error) {
  return (
    String(error?.code ?? "") === "42703" ||
    String(error?.message ?? "").toLowerCase().includes("column")
  );
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
 * Mantém idempotência por (marketplace, external_order_id) e tenta anexar escopo
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
  accessToken
) {
  void accessToken;
  void nowIso;

  const extOrderId = orderDetail?.id != null ? String(orderDetail.id) : null;
  if (!extOrderId) {
    summary.errors.push("order_without_id");
    summary.skipped_count += 1;
    return { ok: false, reason: "order_without_id" };
  }

  const { data: existing, error: exErr } = await supabase
    .from("sales_orders")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("external_order_id", extOrderId)
    .maybeSingle();
  if (exErr) throw exErr;

  const out = await persistMercadoLibreOrder(supabase, userId, orderDetail, {
    marketplace: ML_MARKETPLACE_SLUG,
    log: (msg, extra) => {
      console.log("[Suse7][API][ml-sales-apply]", msg, extra ?? {});
    },
  });

  await applyOrderScopeColumns(
    supabase,
    out?.salesOrderId ?? existing?.id ?? null,
    marketplaceAccountId,
    sellerCompanyId
  );

  summary.synced_count += 1;
  if (existing?.id) summary.updated_count += 1;
  else summary.created_count += 1;

  return { ok: true, salesOrderId: out?.salesOrderId ?? existing?.id ?? null };
}

