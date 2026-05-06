import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

function emptyCompanies() {
  return { ok: true, companies: [] };
}

function shapeCompany(row) {
  const doc = row?.document_cnpj != null ? String(row.document_cnpj).replace(/\D/g, "") : "";
  const maskedDoc =
    doc.length === 14 ? `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5, 8)}/${doc.slice(8, 12)}-${doc.slice(12)}` : null;
  return {
    id: row?.id ?? null,
    name: row?.company_name ?? null,
    company_name: row?.company_name ?? null,
    trade_name: row?.trade_name ?? null,
    document: doc || null,
    document_cnpj: doc || null,
    document_masked: maskedDoc,
    is_main: Boolean(row?.is_primary),
    is_primary: Boolean(row?.is_primary),
    active: row?.active !== false,
    created_at: row?.created_at ?? null,
    default_tax_rate: row?.default_tax_rate ?? null,
    logo_url: row?.logo_url ?? null,
  };
}

async function loadCompanies(supabase, userId) {
  const variants = [
    "id, user_id, company_name, trade_name, document_cnpj, is_primary, active, created_at, default_tax_rate, logo_url",
    "id, user_id, company_name, trade_name, document_cnpj, is_primary, active, created_at",
    "id, user_id, company_name, trade_name, document_cnpj, is_primary, active",
    "id, user_id, company_name, trade_name, document_cnpj",
  ];
  for (const selectExpr of variants) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select(selectExpr)
      .eq("user_id", userId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: false });
    if (!error) return { data: Array.isArray(data) ? data : [], error: null };
    const shapeIssue =
      String(error?.code ?? "") === "42703" || String(error?.message ?? "").toLowerCase().includes("column");
    if (!shapeIssue) return { data: [], error };
  }
  return { data: [], error: null };
}

export default async function handleSellerCompanies(req, res) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      if (req.method === "GET") return res.status(200).json(emptyCompanies());
      return res.status(503).json({ ok: false, error: "Configuração do banco indisponível" });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }
  const { user, supabase } = auth;

  try {
    const path = req.url?.split("?")[0] ?? "";
    const idMatch = path.match(/^\/api\/seller\/companies\/([^/]+)$/);
    const companyId = idMatch?.[1] ?? null;

    if (req.method === "GET" && !companyId) {
      const { data, error } = await loadCompanies(supabase, user.id);
      if (error) {
        console.error("[Suse7][API][seller-companies] failed", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
        });
        return res.status(200).json(emptyCompanies());
      }
      return res.status(200).json({ ok: true, companies: data.map(shapeCompany) });
    }

    if (req.method === "GET" && companyId) {
      const { data, error } = await supabase
        .from("seller_companies")
        .select("*")
        .eq("id", companyId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error || !data) return res.status(404).json({ ok: false, error: "Empresa não encontrada" });
      return res.status(200).json({ ok: true, company: data });
    }

    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const companyName =
        body.company_name != null && String(body.company_name).trim() !== "" ? String(body.company_name).trim() : null;
      const documentCnpj =
        body.document_cnpj != null ? String(body.document_cnpj).replace(/\D/g, "").slice(0, 14) : null;
      if (!companyName || !documentCnpj) {
        return res.status(400).json({ ok: false, error: "company_name e document_cnpj são obrigatórios" });
      }
      const payload = {
        user_id: user.id,
        company_name: companyName,
        trade_name: body.trade_name != null ? String(body.trade_name).trim() || null : null,
        document_cnpj: documentCnpj,
        active: body.active !== false,
      };
      const { data, error } = await supabase.from("seller_companies").insert(payload).select("*").single();
      if (error || !data) {
        console.error("[Suse7][API][seller-companies] failed", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
        });
        return res.status(500).json({ ok: false, error: "Erro ao criar empresa" });
      }
      return res.status(201).json({ ok: true, company: data });
    }

    if (req.method === "PATCH" && companyId) {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const patch = {};
      const fields = [
        "company_name",
        "trade_name",
        "tax_regime",
        "default_tax_rate",
        "operational_cost_rate",
        "internal_notes",
        "phone",
        "whatsapp",
        "cep",
        "address_street",
        "address_number",
        "address_complement",
        "address_district",
        "address_city",
        "address_state",
        "logo_url",
        "active",
      ];
      for (const key of fields) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
      }
      const { data, error } = await supabase
        .from("seller_companies")
        .update(patch)
        .eq("id", companyId)
        .eq("user_id", user.id)
        .select("*")
        .maybeSingle();
      if (error || !data) return res.status(404).json({ ok: false, error: "Empresa não encontrada" });
      return res.status(200).json({ ok: true, company: data });
    }

    return res.status(405).json({ ok: false, error: "Método não permitido" });
  } catch (error) {
    console.error("[Suse7][API][seller-companies] failed", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
    if (req.method === "GET") return res.status(200).json(emptyCompanies());
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
}

