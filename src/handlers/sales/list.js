import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function emptySalesPayload(page, pageSize) {
  return {
    ok: true,
    items: [],
    rows: [],
    page,
    page_size: pageSize,
    total: 0,
    pagination: {
      page,
      page_size: pageSize,
      total: 0,
      truncated_scan: false,
    },
  };
}

export default async function handleSalesList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const page = toPositiveInt(req.query?.page, 1);
  const pageSize = Math.min(200, toPositiveInt(req.query?.page_size, 50));

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json(emptySalesPayload(page, pageSize));
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  const selectVariants = [
    {
      table: "sales_orders",
      select: "id,user_id,marketplace,marketplace_account_id,seller_company_id,external_order_id,date_created_marketplace,total_amount,updated_at,created_at",
      orderBy: "date_created_marketplace",
    },
    {
      table: "sales_orders",
      select: "*",
      orderBy: "created_at",
    },
    {
      table: "sales",
      select: "*",
      orderBy: "created_at",
    },
  ];

  try {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    let rows = [];
    let total = 0;
    let usedTable = null;
    for (const v of selectVariants) {
      const { data, error, count } = await supabase
        .from(v.table)
        .select(v.select, { count: "exact" })
        .eq("user_id", user.id)
        .order(v.orderBy, { ascending: false })
        .range(from, to);
      if (!error) {
        rows = Array.isArray(data) ? data : [];
        total = Number.isFinite(count) ? count : rows.length;
        usedTable = v.table;
        break;
      }
      const isShapeError =
        String(error?.code ?? "") === "42703" ||
        String(error?.message ?? "").toLowerCase().includes("column") ||
        String(error?.message ?? "").toLowerCase().includes("schema cache");
      if (!isShapeError) {
        console.error("[Suse7][API][sales-list] failed", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
          table: v.table,
        });
        return res.status(200).json(emptySalesPayload(page, pageSize));
      }
    }

    if (!usedTable) return res.status(200).json(emptySalesPayload(page, pageSize));
    return res.status(200).json({
      ok: true,
      items: rows,
      rows,
      page,
      page_size: pageSize,
      total,
      pagination: {
        page,
        page_size: pageSize,
        total,
        truncated_scan: false,
      },
      source_table: usedTable,
    });
  } catch (error) {
    console.error("[Suse7][API][sales-list] failed", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
    return res.status(200).json(emptySalesPayload(page, pageSize));
  }
}
