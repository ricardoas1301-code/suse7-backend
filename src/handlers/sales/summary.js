import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import Decimal from "decimal.js";
import {
  fetchOrderIdsFromItemTextSearch,
  fetchVendasSearchOrderIds,
  normalizeSearchQuery,
} from "./_vendasSalesRows.js";

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
  try {
    return new Decimal(String(value).replace(",", "."))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);
  } catch {
    return "0.00";
  }
}

function toDecimal(value) {
  if (value == null || value === "") return null;
  try {
    const d = new Decimal(String(value).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
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
  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) return;
  const marketplace =
    req.query?.marketplace != null && String(req.query.marketplace).trim() !== ""
      ? String(req.query.marketplace).trim()
      : null;
  const marketplaceAccountId =
    req.query?.marketplace_account_id != null && String(req.query.marketplace_account_id).trim() !== ""
      ? String(req.query.marketplace_account_id).trim()
      : null;
  const qRaw =
    req.query?.q != null && String(req.query.q).trim() !== "" ? String(req.query.q).trim() : null;
  const qNormalized = qRaw ? normalizeSearchQuery(qRaw) : null;

  try {
    let orderIdsQuery = supabase
      .from("sales_orders")
      .select("id")
      .eq("user_id", user.id);
    if (marketplace) orderIdsQuery = orderIdsQuery.eq("marketplace", marketplace);
    if (marketplaceAccountId) orderIdsQuery = orderIdsQuery.eq("marketplace_account_id", marketplaceAccountId);

    if (qNormalized) {
      const [fromOrders, fromItems] = await Promise.all([
        fetchVendasSearchOrderIds(supabase, user.id, qNormalized, 800),
        fetchOrderIdsFromItemTextSearch(supabase, user.id, qNormalized, 1200),
      ]);
      const merged = new Set([...fromOrders, ...fromItems]);
      if (merged.size === 0) return res.status(200).json(emptySummary());
      const cap = 1500;
      orderIdsQuery = orderIdsQuery.in("id", [...merged].slice(0, cap));
    }

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
    let gross = new Decimal(0);
    let net = new Decimal(0);
    let units = 0;
    let fees = new Decimal(0);
    let shippingFees = new Decimal(0);
    /** @type {Set<string>} */
    const uniqueOrders = new Set();
    for (const row of rows) {
      const g = toDecimal(row?.gross_amount) ?? new Decimal(0);
      const n = toDecimal(row?.net_amount) ?? g;
      const q = Number.parseInt(String(row?.quantity ?? "1"), 10) || 0;
      const f = toDecimal(row?.fee_amount) ?? new Decimal(0);
      const s = toDecimal(row?.shipping_share_amount) ?? new Decimal(0);
      gross = gross.plus(g);
      net = net.plus(n);
      units += q;
      fees = fees.plus(f);
      shippingFees = shippingFees.plus(s);
      if (row?.sales_order_id) uniqueOrders.add(String(row.sales_order_id));
    }

    const salesCount = uniqueOrders.size;
    const avgTicket = salesCount > 0 ? net.div(salesCount) : new Decimal(0);

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
        loss_orders_count: net.lt(0) ? salesCount : 0,
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
