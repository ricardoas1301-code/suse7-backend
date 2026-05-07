import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export default async function handleCustomersList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({ ok: true, customers: [], total: 0 });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const page = toPositiveInt(req.query?.page, 1);
  const pageSize = Math.min(200, toPositiveInt(req.query?.page_size, 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const marketplace =
    req.query?.marketplace != null && String(req.query.marketplace).trim() !== ""
      ? String(req.query.marketplace).trim()
      : null;

  try {
    const q = supabase
      .from("marketplace_customers")
      .select("id,name,email,phone,external_customer_id,marketplace,marketplace_account_id,seller_company_id,updated_at", {
        count: "exact",
      })
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .range(from, to);
    if (marketplace) q.eq("marketplace", marketplace);

    const { data, error, count } = await q;
    if (error) {
      const shape =
        String(error?.code ?? "") === "42703" ||
        String(error?.message ?? "").toLowerCase().includes("column") ||
        String(error?.message ?? "").toLowerCase().includes("schema cache");
      if (shape) return res.status(200).json({ ok: true, customers: [], total: 0 });
      console.error("[Suse7][API][customers-list] failed", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      return res.status(500).json({ ok: false, error: "Erro ao carregar clientes." });
    }

    return res.status(200).json({
      ok: true,
      customers: Array.isArray(data) ? data : [],
      total: Number.isFinite(count) ? count : Array.isArray(data) ? data.length : 0,
      page,
      page_size: pageSize,
    });
  } catch (e) {
    console.error("[Suse7][API][customers-list] fatal", e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}

