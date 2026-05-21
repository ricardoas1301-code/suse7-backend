import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { buildCustomerDetail } from "../../services/customers/customerReadModelService.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMissingTableOrColumn(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("column");
}

export default async function handleCustomersDetail(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const customerId = safeStr(req.params?.customerId ?? req.params?.id);
  if (!customerId || !UUID_RE.test(customerId)) {
    return res.status(404).json({ ok: false, error: "Cliente não encontrado." });
  }

  const { user, supabase } = auth;

  try {
    const detail = await buildCustomerDetail(supabase, user.id, customerId, req.query ?? {});
    if (!detail) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado." });
    }

    return res.status(200).json({
      ok: true,
      ...detail,
    });
  } catch (e) {
    if (isMissingTableOrColumn(e)) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado." });
    }
    console.error("[Suse7][API][customers-detail] fatal", { customerId, message: e?.message });
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}

/** @param {unknown} v */
function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
