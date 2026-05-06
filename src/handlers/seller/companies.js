import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

function trimStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

/** Schema real: company_name / trade_name — compat com payloads legados (`name`, etc.). */
function pickCompanyLegalName(body) {
  const b = body && typeof body === "object" ? body : {};
  const candidates = [trimStr(b.company_name), trimStr(b.razao_social), trimStr(b.name), trimStr(b.nome_empresa)];
  const hit = candidates.find((s) => s !== "");
  return hit || null;
}

function pickDocumentCnpj14(body) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.document_cnpj ?? b.document ?? b.cnpj ?? b.cpf_cnpj ?? "";
  const digits = String(raw).replace(/\D/g, "").slice(0, 14);
  return digits.length === 14 ? digits : null;
}

/**
 * Lê profiles pelo schema real: id = auth user id (não existe profiles.user_id).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function loadProfileForSellerBootstrap(supabase, userId) {
  const variants = ["id, nome, nome_loja, email, cpf_cnpj, name", "id, nome, nome_loja, email, cpf_cnpj"];
  for (const sel of variants) {
    const { data, error } = await supabase.from("profiles").select(sel).eq("id", userId).maybeSingle();
    if (!error) return data;
    const shapeIssue =
      String(error?.code ?? "") === "42703" || String(error?.message ?? "").toLowerCase().includes("column");
    if (!shapeIssue) return null;
  }
  return null;
}

/**
 * Deriva company_name / trade_name do profile real (sem coluna seller_companies.name).
 */
function companyNamesFromProfile(prof) {
  if (!prof) return { company_name: null, trade_name: null };
  const loja = trimStr(prof.nome_loja);
  const nome = trimStr(prof.nome);
  const nameCol = trimStr(prof.name);
  const email = trimStr(prof.email);
  const company_name = loja || nome || nameCol || email || null;
  const trade_name = loja || company_name;
  return { company_name, trade_name };
}

/**
 * Se não houver seller_company e o profile tiver CNPJ (14 dígitos), cria a primeira linha.
 * Nunca envia coluna `name` em seller_companies.
 */
async function tryBootstrapSellerCompanyFromProfile(supabase, userId) {
  const prof = await loadProfileForSellerBootstrap(supabase, userId);
  const { company_name, trade_name } = companyNamesFromProfile(prof);
  const doc = String(prof?.cpf_cnpj ?? "").replace(/\D/g, "");
  if (doc.length !== 14 || !company_name) {
    return { created: false, reason: "not_cnpj_or_missing_name" };
  }

  const { data: dup } = await supabase
    .from("seller_companies")
    .select("id")
    .eq("user_id", userId)
    .eq("document_cnpj", doc)
    .maybeSingle();
  if (dup?.id) {
    return { created: false, reason: "already_exists" };
  }

  const payload = {
    user_id: userId,
    company_name,
    trade_name: trade_name || company_name,
    document_cnpj: doc,
    active: true,
    is_primary: true,
  };

  let { error } = await supabase.from("seller_companies").insert(payload).select("id").single();
  if (
    error &&
    payload.is_primary != null &&
    String(error?.message ?? "")
      .toLowerCase()
      .includes("is_primary")
  ) {
    delete payload.is_primary;
    ({ error } = await supabase.from("seller_companies").insert(payload).select("id").single());
  }
  if (error) {
    console.error("[Suse7][API][seller-companies] bootstrap_from_profile failed", {
      message: error?.message,
      code: error?.code,
    });
    return { created: false, reason: "insert_failed" };
  }
  return { created: true };
}

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
  const selectVariants = [
    "id, user_id, company_name, trade_name, document_cnpj, is_primary, active, created_at, default_tax_rate, logo_url",
    "id, user_id, company_name, trade_name, document_cnpj, is_primary, active, created_at",
    "id, user_id, company_name, trade_name, document_cnpj, is_primary, active",
    "id, user_id, company_name, trade_name, document_cnpj",
  ];
  for (const selectExpr of selectVariants) {
    const hasPrimaryCol = selectExpr.includes("is_primary");
    const orderModes = hasPrimaryCol ? [{ primary: true }, { primary: false }] : [{ primary: false }];
    for (const ord of orderModes) {
      let q = supabase.from("seller_companies").select(selectExpr).eq("user_id", userId);
      if (ord.primary) {
        q = q.order("is_primary", { ascending: false });
      }
      q = q.order("created_at", { ascending: false });
      const { data, error } = await q;
      if (!error) return { data: Array.isArray(data) ? data : [], error: null };
      const shapeIssue =
        String(error?.code ?? "") === "42703" || String(error?.message ?? "").toLowerCase().includes("column");
      if (!shapeIssue) return { data: [], error };
    }
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
      let { data, error } = await loadCompanies(supabase, user.id);
      if (error) {
        console.error("[Suse7][API][seller-companies] failed", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
        });
        return res.status(200).json(emptyCompanies());
      }
      if (!data?.length) {
        await tryBootstrapSellerCompanyFromProfile(supabase, user.id);
        ({ data, error } = await loadCompanies(supabase, user.id));
        if (error) {
          console.error("[Suse7][API][seller-companies] reload after bootstrap failed", {
            message: error?.message,
            code: error?.code,
          });
          return res.status(200).json(emptyCompanies());
        }
      }
      return res.status(200).json({ ok: true, companies: (data ?? []).map(shapeCompany) });
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
      const companyName = pickCompanyLegalName(body);
      const documentCnpj = pickDocumentCnpj14(body);
      if (!companyName || !documentCnpj) {
        return res.status(400).json({
          ok: false,
          error: "company_name (ou name legado) e document_cnpj (14 dígitos) são obrigatórios",
        });
      }
      const tradeRaw =
        body.trade_name != null && String(body.trade_name).trim() !== "" ? String(body.trade_name).trim() : null;
      const payload = {
        user_id: user.id,
        company_name: companyName,
        trade_name: tradeRaw ?? companyName,
        document_cnpj: documentCnpj,
        active: body.active !== false,
      };

      const { count, error: countErr } = await supabase
        .from("seller_companies")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);
      if (!countErr && Number(count) === 0) {
        payload.is_primary = body.is_primary !== false;
      }

      let { data, error } = await supabase.from("seller_companies").insert(payload).select("*").single();
      if (
        error &&
        payload.is_primary != null &&
        String(error?.message ?? "")
          .toLowerCase()
          .includes("is_primary")
      ) {
        delete payload.is_primary;
        ({ data, error } = await supabase.from("seller_companies").insert(payload).select("*").single());
      }
      if (error || !data) {
        const dup =
          String(error?.code ?? "") === "23505" ||
          String(error?.message ?? "")
            .toLowerCase()
            .includes("duplicate");
        if (dup) {
          return res.status(409).json({ ok: false, error: "Empresa já cadastrada para este CNPJ" });
        }
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
      let body = req.body && typeof req.body === "object" ? req.body : {};
      if (body.name != null && trimStr(body.name) !== "" && !Object.prototype.hasOwnProperty.call(body, "company_name")) {
        body = { ...body, company_name: trimStr(body.name) };
      }
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

