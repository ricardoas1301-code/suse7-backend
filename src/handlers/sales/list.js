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

  try {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const query = supabase
      .from("sales")
      .select("*", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range(from, to);

    const { data, error, count } = await query;
    if (error) {
      console.error("[Suse7][API][sales-list] failed", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      return res.status(200).json(emptySalesPayload(page, pageSize));
    }

    const rows = Array.isArray(data) ? data : [];
    return res.status(200).json({
      ok: true,
      items: rows,
      rows,
      page,
      page_size: pageSize,
      total: Number.isFinite(count) ? count : rows.length,
      pagination: {
        page,
        page_size: pageSize,
        total: Number.isFinite(count) ? count : rows.length,
        truncated_scan: false,
      },
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
