// ======================================================
// GET /api/ml/sales-summary
// Totais simples + top anúncios por faturamento bruto + último sync de métricas.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";

const TOP_LIMIT = Math.min(
  50,
  Math.max(1, parseInt(process.env.ML_SALES_SUMMARY_TOP || "10", 10) || 10)
);

export default async function handleMlSalesSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const userId = user.id;
  const marketplace = ML_MARKETPLACE_SLUG;

  try {
    const { count: total_orders, error: ordErr } = await supabase
      .from("sales_orders")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("marketplace", marketplace);

    if (ordErr) {
      console.error("[ml/sales-summary] count_orders", ordErr);
      return res.status(500).json({ ok: false, error: "Falha ao contar pedidos" });
    }

    const { data: items, error: itemsErr } = await supabase
      .from("sales_order_items")
      .select("quantity, gross_amount, net_amount")
      .eq("user_id", userId)
      .eq("marketplace", marketplace);

    if (itemsErr) {
      console.error("[ml/sales-summary] items_agg", itemsErr);
      return res.status(500).json({ ok: false, error: "Falha ao agregar itens" });
    }

    let total_items_sold = 0;
    let gross_revenue_total = 0;
    let net_revenue_total = 0;

    for (const it of items || []) {
      const q = Math.trunc(Number(it.quantity)) || 0;
      total_items_sold += q;
      const g = Number(it.gross_amount);
      const gross = Number.isFinite(g) ? g : 0;
      gross_revenue_total += gross;
      const n = it.net_amount != null ? Number(it.net_amount) : null;
      net_revenue_total += n != null && Number.isFinite(n) ? n : gross;
    }

    const { data: top_listings, error: topErr } = await supabase
      .from("listing_sales_metrics")
      .select(
        "external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, orders_count, last_sale_at"
      )
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .order("gross_revenue_total", { ascending: false })
      .limit(TOP_LIMIT);

    if (topErr) {
      console.error("[ml/sales-summary] top_listings", topErr);
      return res.status(500).json({ ok: false, error: "Falha ao listar top anúncios" });
    }

    const { data: syncRow, error: syncErr } = await supabase
      .from("listing_sales_metrics")
      .select("last_sync_at")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .order("last_sync_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (syncErr) {
      console.error("[ml/sales-summary] last_sync", syncErr);
    }

    const last_sync_at = syncRow?.last_sync_at ?? null;

    return res.status(200).json({
      ok: true,
      marketplace,
      total_orders: total_orders ?? 0,
      total_items_sold,
      gross_revenue_total,
      net_revenue_total,
      top_listings: top_listings || [],
      last_sync_at,
    });
  } catch (err) {
    console.error("[ml/sales-summary] fatal", err);
    return res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
}
