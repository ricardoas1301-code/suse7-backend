import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { isValidCnpjInput, normalizeCnpjDigits } from "../../domain/taxIdBr/cnpjDigits.js";
import {
  buildSellerCompanyWritableFields,
  isSupabaseMissingColumnError,
  normalizeSellerCompanyPercentDecimal,
  resolveAuthenticatedContactEmail,
  validateSellerCompanyConfigurationOnboardingCreateBody,
  validateSellerCompanyCreateBody,
} from "../../domain/seller/sellerCompanyRecord.js";
import {
  ensurePrimaryCompanyDefaultRecipient,
  syncPrimaryCompanyRecipientContactsFromCompany,
} from "../../domain/notifications/central/recipients/primaryCompanyDefaultRecipientService.js";

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
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown> | null | undefined} companyRow
 * @param {{ bootstrap?: boolean }} [options]
 */
async function maybeEnsureDefaultRecipientForPrimaryCompany(supabase, userId, companyRow, options = {}) {
  if (!companyRow || typeof companyRow !== "object") return;
  const isPrimary = companyRow.is_primary === true || companyRow.is_primary === "true";
  if (!isPrimary) return;
  try {
    if (options.bootstrap === false) {
      await syncPrimaryCompanyRecipientContactsFromCompany(supabase, userId);
    } else {
      await ensurePrimaryCompanyDefaultRecipient(supabase, userId);
    }
  } catch (err) {
    console.warn("[Suse7][API][seller-companies] default_recipient_sync_failed", {
      user_id: userId,
      message: err?.message,
    });
  }
}

/**
 * Se não houver seller_company e o profile tiver CNPJ (14 dígitos), cria a primeira linha.
 * Nunca envia coluna `name` em seller_companies.
 */
async function tryBootstrapSellerCompanyFromProfile(supabase, userId) {
  const prof = await loadProfileForSellerBootstrap(supabase, userId);
  const { company_name, trade_name } = companyNamesFromProfile(prof);
  const doc = normalizeCnpjDigits(String(prof?.cpf_cnpj ?? ""));
  if (!isValidCnpjInput(doc) || !company_name) {
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
        const primaryAfterBootstrap = (data ?? []).find((c) => c.is_primary === true) ?? data?.[0] ?? null;
        await maybeEnsureDefaultRecipientForPrimaryCompany(supabase, user.id, primaryAfterBootstrap);
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
      const configurationOnboarding = body.configuration_onboarding === true;

      const createValidation = configurationOnboarding
        ? validateSellerCompanyConfigurationOnboardingCreateBody(body)
        : validateSellerCompanyCreateBody(body);
      if (!createValidation.ok) {
        return res.status(400).json({
          ok: false,
          error: createValidation.errors[0] ?? "Dados inválidos para cadastro de empresa.",
        });
      }

      const companyName = pickCompanyLegalName(body);
      const documentCnpj = pickDocumentCnpj14(body);
      if (!companyName || !documentCnpj) {
        return res.status(400).json({
          ok: false,
          error: "company_name (ou name legado) e document_cnpj (14 dígitos) são obrigatórios",
        });
      }
      const docNorm = normalizeCnpjDigits(documentCnpj);
      if (!isValidCnpjInput(docNorm)) {
        console.warn("[company/profile] cnpj_validation_failed", {
          user_id: user.id,
          reason: "invalid_format_or_checksum",
        });
        return res.status(400).json({
          ok: false,
          error: "CNPJ inválido. Confira os números e tente novamente.",
        });
      }

      const { count: existingCount, error: countErr } = await supabase
        .from("seller_companies")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);

      const willBePrimary = !countErr && Number(existingCount) === 0 && body.is_primary !== false;
      const writablePreview = buildSellerCompanyWritableFields(body);
      /** @type {{ ok: boolean; email?: string; error?: string; code?: string }} */
      let emailResolution;
      if (configurationOnboarding || willBePrimary) {
        emailResolution = resolveAuthenticatedContactEmail(user.email, body.contact_email);
      } else if (writablePreview.contact_email) {
        emailResolution = { ok: true, email: String(writablePreview.contact_email) };
      } else {
        emailResolution = {
          ok: false,
          code: "CONTACT_EMAIL_INVALID",
          error: "E-mail da empresa é obrigatório.",
        };
      }

      if (!emailResolution.ok) {
        return res.status(400).json({
          ok: false,
          error: emailResolution.error,
          code: emailResolution.code,
        });
      }

      if (configurationOnboarding && !countErr && Number(existingCount) > 0) {
        let { data: existingCompanies } = await loadCompanies(supabase, user.id);
        const primary =
          (existingCompanies ?? []).find((row) => row.is_primary === true) ?? existingCompanies?.[0] ?? null;
        if (primary?.id) {
          return res.status(200).json({ ok: true, company: primary, idempotent: true });
        }
      }

      const { data: dupPre } = await supabase
        .from("seller_companies")
        .select("id")
        .eq("user_id", user.id)
        .eq("document_cnpj", docNorm)
        .maybeSingle();
      if (dupPre?.id) {
        console.warn("[company/profile] duplicate_cnpj_blocked", { user_id: user.id });
        return res.status(409).json({ ok: false, error: "Este CNPJ já está cadastrado no seu perfil." });
      }

      const tradeRaw =
        body.trade_name != null && String(body.trade_name).trim() !== "" ? String(body.trade_name).trim() : null;
      const writable = buildSellerCompanyWritableFields(body);
      const payload = {
        user_id: user.id,
        company_name: companyName,
        trade_name: tradeRaw ?? companyName,
        document_cnpj: docNorm,
        active: body.active !== false,
        contact_email: emailResolution.email,
        ...writable,
      };

      if (!countErr && Number(existingCount) === 0) {
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
          console.warn("[company/profile] duplicate_cnpj_blocked", { user_id: user.id, source: "db_unique" });
          return res.status(409).json({ ok: false, error: "Este CNPJ já está cadastrado no seu perfil." });
        }
        console.error("[Suse7][API][seller-companies] failed", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
        });
        if (isSupabaseMissingColumnError(error)) {
          return res.status(500).json({
            ok: false,
            error: "Não foi possível salvar a empresa. Schema incompleto no ambiente.",
          });
        }
        return res.status(500).json({ ok: false, error: "Erro ao criar empresa" });
      }
      await maybeEnsureDefaultRecipientForPrimaryCompany(supabase, user.id, data);
      return res.status(201).json({ ok: true, company: data });
    }

    if (req.method === "PATCH" && companyId) {
      let body = req.body && typeof req.body === "object" ? req.body : {};
      if (body.name != null && trimStr(body.name) !== "" && !Object.prototype.hasOwnProperty.call(body, "company_name")) {
        body = { ...body, company_name: trimStr(body.name) };
      }

      const { data: existing, error: existingErr } = await supabase
        .from("seller_companies")
        .select("id, is_primary, contact_email")
        .eq("id", companyId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (existingErr) {
        console.error("[Suse7][API][seller-companies] patch lookup failed", {
          message: existingErr?.message,
          code: existingErr?.code,
        });
        return res.status(500).json({ ok: false, error: "Erro ao atualizar empresa" });
      }
      if (!existing?.id) {
        return res.status(404).json({ ok: false, error: "Empresa não encontrada" });
      }

      const patch = buildSellerCompanyWritableFields(body);
      const isPrimaryCompany = existing.is_primary === true || existing.is_primary === "true";
      if (isPrimaryCompany && Object.prototype.hasOwnProperty.call(body, "contact_email")) {
        const emailResolution = resolveAuthenticatedContactEmail(user.email, body.contact_email);
        if (!emailResolution.ok) {
          return res.status(400).json({
            ok: false,
            error: emailResolution.error,
            code: emailResolution.code,
          });
        }
        patch.contact_email = emailResolution.email;
      }
      if (Object.prototype.hasOwnProperty.call(body, "default_tax_rate")) {
        const tax = normalizeSellerCompanyPercentDecimal(body.default_tax_rate);
        if (body.default_tax_rate != null && String(body.default_tax_rate).trim() !== "" && tax == null) {
          return res.status(400).json({ ok: false, error: "Alíquota de imposto inválida." });
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, "operational_cost_rate")) {
        const op = normalizeSellerCompanyPercentDecimal(body.operational_cost_rate);
        if (
          body.operational_cost_rate != null &&
          String(body.operational_cost_rate).trim() !== "" &&
          op == null
        ) {
          return res.status(400).json({ ok: false, error: "Custo operacional inválido." });
        }
      }

      const { data, error } = await supabase
        .from("seller_companies")
        .update(patch)
        .eq("id", companyId)
        .eq("user_id", user.id)
        .select("*")
        .maybeSingle();

      if (error) {
        console.error("[Suse7][API][seller-companies] patch failed", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
          company_id: companyId,
          user_id: user.id,
        });
        if (isSupabaseMissingColumnError(error)) {
          return res.status(500).json({
            ok: false,
            error: "Não foi possível salvar as alterações. Tente novamente.",
          });
        }
        return res.status(500).json({ ok: false, error: "Erro ao atualizar empresa" });
      }
      if (!data) {
        return res.status(404).json({ ok: false, error: "Empresa não encontrada" });
      }
      await maybeEnsureDefaultRecipientForPrimaryCompany(supabase, user.id, data, { bootstrap: false });
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

