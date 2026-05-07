import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

function emptySummary() {
  return {
    ok: true,
    summary: {
      product_revenue_brl: "0.00",
      gross_revenue_brl: "0.00",
      net_total_brl: "0.00",
      sales_count: 0,
      total_sales_count: 0,
      units_count: 0,
      total_units: 0,
      average_ticket_brl: "0.00",
      avg_ticket_brl: "0.00",
      fees_total_brl: "0.00",
      total_fees_brl: "0.00",
      total_shipping_fees_brl: "0.00",
      total_refunds_brl: "0.00",
      loss_orders_count: 0,
      orders_count: 0,
    },
    truncated_scan: false,
  };
}

function toMoneyString(value) {
  if (value == null || value === "") return "0.00";
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

export default async function handleSalesSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json(emptySummary());
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const marketplace =
    req.query?.marketplace != null && String(req.query.marketplace).trim() !== ""
      ? String(req.query.marketplace).trim()
      : null;

  try {
    const orderIdsQuery = supabase
      .from("sales_orders")
      .select("id")
      .eq("user_id", user.id);
    if (marketplace) orderIdsQuery.eq("marketplace", marketplace);
    const { data: orderRows, error: orderErr } = await orderIdsQuery;
    if (orderErr) {
      console.error("[Suse7][API][sales-summary] orders_failed", {
        message: orderErr?.message,
        code: orderErr?.code,
        details: orderErr?.details,
      });
      return res.status(200).json(emptySummary());
    }

    const orderIds = Array.isArray(orderRows) ? orderRows.map((r) => r.id).filter(Boolean) : [];
    if (orderIds.length === 0) return res.status(200).json(emptySummary());

    const { data: itemRows, error: itemErr } = await supabase
      .from("sales_order_items")
      .select("sales_order_id, quantity, gross_amount, net_amount, fee_amount, shipping_share_amount")
      .eq("user_id", user.id)
      .in("sales_order_id", orderIds);
    if (itemErr) {
      console.error("[Suse7][API][sales-summary] items_failed", {
        message: itemErr?.message,
        code: itemErr?.code,
        details: itemErr?.details,
      });
      return res.status(200).json(emptySummary());
    }

    const rows = Array.isArray(itemRows) ? itemRows : [];
    let gross = 0;
    let net = 0;
    let units = 0;
    let fees = 0;
    let shippingFees = 0;
    /** @type {Set<string>} */
    const uniqueOrders = new Set();
    for (const row of rows) {
      const g = Number(String(row?.gross_amount ?? "0").replace(",", ".")) || 0;
      const n =
        row?.net_amount != null
          ? Number(String(row?.net_amount).replace(",", ".")) || 0
          : g;
      const q = Number.parseInt(String(row?.quantity ?? "1"), 10) || 0;
      const f = Number(String(row?.fee_amount ?? "0").replace(",", ".")) || 0;
      const s = Number(String(row?.shipping_share_amount ?? "0").replace(",", ".")) || 0;
      gross += g;
      net += n;
      units += q;
      fees += f;
      shippingFees += s;
      if (row?.sales_order_id) uniqueOrders.add(String(row.sales_order_id));
    }

    const salesCount = uniqueOrders.size;
    const avgTicket = salesCount > 0 ? net / salesCount : 0;

    return res.status(200).json({
      ok: true,
      summary: {
        product_revenue_brl: toMoneyString(gross),
        gross_revenue_brl: toMoneyString(gross),
        net_total_brl: toMoneyString(net),
        sales_count: salesCount,
        total_sales_count: salesCount,
        units_count: units,
        total_units: units,
        average_ticket_brl: toMoneyString(avgTicket),
        avg_ticket_brl: toMoneyString(avgTicket),
        fees_total_brl: toMoneyString(fees),
        total_fees_brl: toMoneyString(fees),
        total_shipping_fees_brl: toMoneyString(shippingFees),
        total_refunds_brl: "0.00",
        loss_orders_count: net < 0 ? salesCount : 0,
        orders_count: salesCount,
      },
      truncated_scan: false,
      source_table: "sales_order_items",
    });
  } catch (error) {
    console.error("[Suse7][API][sales-summary] failed", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
    return res.status(200).json(emptySummary());
  }
}
