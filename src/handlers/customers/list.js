import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { buildCustomersList } from "../../services/customers/customerReadModelService.js";

function isMissingTableOrColumn(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("column");
}

export default async function handleCustomersList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({
        ok: true,
        customers: [],
        total: 0,
        page: 1,
        page_size: 50,
        summary: null,
        filters: null,
        pagination: { page: 1, page_size: 50, total: 0, total_pages: 1 },
      });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  try {
    const payload = await buildCustomersList(supabase, user.id, req.query ?? {});

    return res.status(200).json({
      ok: true,
      summary: payload.summary,
      filters: payload.filters,
      customers: payload.customers,
      pagination: payload.pagination,
      total: payload.total,
      page: payload.page,
      page_size: payload.page_size,
    });
  } catch (e) {
    if (isMissingTableOrColumn(e)) {
      return res.status(200).json({
        ok: true,
        customers: [],
        total: 0,
        page: 1,
        page_size: 50,
        summary: null,
        filters: null,
        pagination: { page: 1, page_size: 50, total: 0, total_pages: 1 },
      });
    }
    console.error("[Suse7][API][customers-list] fatal", e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}
