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

  try {
    const { data, error } = await supabase
      .from("sales")
      .select("sale_amount_brl, net_total_brl, quantity")
      .eq("user_id", user.id);

    if (error) {
      console.error("[Suse7][API][sales-summary] failed", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      return res.status(200).json(emptySummary());
    }

    const rows = Array.isArray(data) ? data : [];
    let gross = 0;
    let net = 0;
    let units = 0;
    for (const row of rows) {
      gross += Number(String(row?.sale_amount_brl ?? "0").replace(",", ".")) || 0;
      net += Number(String(row?.net_total_brl ?? "0").replace(",", ".")) || 0;
      units += Number.parseInt(String(row?.quantity ?? "1"), 10) || 0;
    }
    const salesCount = rows.length;
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
        fees_total_brl: "0.00",
        total_fees_brl: "0.00",
        total_shipping_fees_brl: "0.00",
        total_refunds_brl: "0.00",
        loss_orders_count: 0,
        orders_count: salesCount,
      },
      truncated_scan: false,
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
