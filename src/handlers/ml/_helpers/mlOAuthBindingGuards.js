// ======================================================================
// Regras de vínculo OAuth ML: 1 empresa ↔ no máx. 1 conta ativa por marketplace;
// 1 external_seller_id não pode saltar entre empresas do mesmo usuário.
// Guard global cross-tenant: mesma conta ML não pode vincular a outra empresa SUSE7.
// ======================================================================

/** Copy aprovada — zero PII da outra empresa/tenant. */
export const ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE =
  "Esta conta do Mercado Livre já está vinculada a outra empresa. Verifique a conta autorizada no Mercado Livre e tente novamente.";

/**
 * @param {string | null | undefined} status
 */
export function marketplaceAccountBindingAtivo(status) {
  const s = status != null ? String(status).trim().toLowerCase() : "";
  return s !== "removed";
}

/**
 * @param {string | null | undefined} s
 */
export function normalizeTaxDigits(s) {
  return String(s ?? "").replace(/\D/g, "");
}

/**
 * Tenta extrair CPF/CNPJ numérico do payload GET /users/me (quando existir).
 * @param {Record<string, unknown> | null | undefined} me
 */
export function extractMlMeTaxDigits(me) {
  if (!me || typeof me !== "object") return "";
  const idn = /** @type {Record<string, unknown> | undefined} */ (me.identification);
  if (idn && typeof idn === "object") {
    const num = idn.number != null ? String(idn.number) : "";
    const digits = normalizeTaxDigits(num);
    if (digits.length >= 11) return digits;
  }
  const tags = me.tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t && typeof t === "object" && "identifier" in t) {
        const d = normalizeTaxDigits(/** @type {{ identifier?: string }} */ (t).identifier);
        if (d.length >= 11) return d;
      }
    }
  }
  return "";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} sellerCompanyId
 */
export async function fetchSellerCompanyTaxDigits(supabase, userId, sellerCompanyId) {
  const uid = String(userId || "").trim();
  const sid = String(sellerCompanyId || "").trim();
  if (!uid || !sid) return { digits: "", error: null };
  const variants = ["document_cnpj", "document_cnpj, company_name", "id"];
  for (const sel of variants) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select(sel)
      .eq("id", sid)
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      const shape =
        String(error.code ?? "") === "42703" || String(error.message ?? "").toLowerCase().includes("column");
      if (shape) continue;
      return { digits: "", error };
    }
    const raw = data && typeof data === "object" && "document_cnpj" in data ? data.document_cnpj : null;
    const digits = normalizeTaxDigits(raw != null ? String(raw) : "");
    return { digits, error: null };
  }
  return { digits: "", error: null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {string} externalSellerId
 * @param {string} resolvedSellerCompanyId
 * @returns {Promise<{ ok: true } | { ok: false; code: string; message: string }>}
 */
export async function assertMlBindingAllowedBeforeUpsert(
  supabase,
  userId,
  marketplace,
  externalSellerId,
  resolvedSellerCompanyId
) {
  const uid = String(userId || "").trim();
  const mp = String(marketplace || "").trim();
  const ext = String(externalSellerId || "").trim();
  const co = String(resolvedSellerCompanyId || "").trim();
  if (!uid || !mp || !ext || !co) {
    return { ok: false, code: "ml_binding_guard_invalid_input", message: "Parâmetros de vínculo inválidos." };
  }

  const { data: byExt, error: e1 } = await supabase
    .from("marketplace_accounts")
    .select("id, seller_company_id, external_seller_id, status")
    .eq("user_id", uid)
    .eq("marketplace", mp)
    .eq("external_seller_id", ext)
    .neq("status", "removed");

  if (e1) {
    return { ok: false, code: "ml_binding_guard_query", message: e1.message ?? String(e1) };
  }
  const rowsExt = Array.isArray(byExt) ? byExt : [];
  for (const r of rowsExt) {
    const rowCo = r?.seller_company_id != null ? String(r.seller_company_id).trim() : "";
    if (rowCo && rowCo !== co) {
      return {
        ok: false,
        code: "ml_seller_wrong_company",
        message:
          "Essa conta Mercado Livre já está vinculada a outra empresa no Suse7. Verifique se você entrou na conta correta do Mercado Livre.",
      };
    }
  }

  const { data: byCo, error: e2 } = await supabase
    .from("marketplace_accounts")
    .select("id, external_seller_id, status")
    .eq("user_id", uid)
    .eq("marketplace", mp)
    .eq("seller_company_id", co)
    .neq("status", "removed");

  if (e2) {
    return { ok: false, code: "ml_binding_guard_query", message: e2.message ?? String(e2) };
  }
  const rowsCo = Array.isArray(byCo) ? byCo : [];
  for (const r of rowsCo) {
    const rowExt = r?.external_seller_id != null ? String(r.external_seller_id).trim() : "";
    if (rowExt && rowExt !== ext) {
      return {
        ok: false,
        code: "ml_company_already_connected",
        message:
          "Esta empresa já possui outra conta Mercado Livre conectada. Cada CNPJ pode ter no máximo uma conta por marketplace.",
      };
    }
  }

  return { ok: true };
}

/**
 * Impede vínculo global: mesma conta ML (external_seller_id) em outra empresa/tenant ativa.
 * Reconnect same user+company → allow (idempotente).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} marketplace
 * @param {string} externalSellerId
 * @param {string} currentUserId
 * @param {string} resolvedSellerCompanyId
 * @returns {Promise<{ ok: true } | { ok: false; code: string; message: string }>}
 */
export async function assertMlGlobalAccountNotLinkedElsewhere(
  supabase,
  marketplace,
  externalSellerId,
  currentUserId,
  resolvedSellerCompanyId,
) {
  const mp = String(marketplace || "").trim();
  const ext = String(externalSellerId || "").trim();
  const uid = String(currentUserId || "").trim();
  const co = String(resolvedSellerCompanyId || "").trim();
  if (!mp || !ext || !uid || !co) {
    return { ok: false, code: "ml_global_guard_invalid_input", message: "Parâmetros de vínculo inválidos." };
  }

  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id, user_id, seller_company_id, status")
    .eq("marketplace", mp)
    .eq("external_seller_id", ext)
    .limit(20);

  if (error) {
    return { ok: false, code: "ml_global_guard_query", message: error.message ?? String(error) };
  }

  const rows = (Array.isArray(data) ? data : []).filter((r) => marketplaceAccountBindingAtivo(r?.status));
  for (const r of rows) {
    const rowUser = r?.user_id != null ? String(r.user_id).trim() : "";
    const rowCo = r?.seller_company_id != null ? String(r.seller_company_id).trim() : "";
    if (rowUser === uid && rowCo === co) continue;
    return {
      ok: false,
      code: rowUser === uid ? "ml_seller_wrong_company" : "ml_account_linked_elsewhere",
      message: ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE,
    };
  }

  return { ok: true };
}

/**
 * Quando o ML envia documento (CPF/CNPJ), exige compatibilidade com o CNPJ da empresa no Suse7.
 * @param {string} mlDigits — apenas dígitos (ex.: extractMlMeTaxDigits)
 * @param {string} companyDigits — apenas dígitos; esperado 14 para PJ
 * @returns {{ ok: true, reason: string } | { ok: false, reason: string }}
 */
export function assertMlDocumentMatchesSellerCompanyCnpj(mlDigits, companyDigits) {
  const ml = normalizeTaxDigits(mlDigits);
  const co = normalizeTaxDigits(companyDigits);
  if (ml.length < 11) return { ok: true, reason: "ml_document_absent" };
  if (co.length !== 14) return { ok: true, reason: "company_cnpj_absent" };
  if (ml.length === 11) return { ok: false, reason: "ml_cpf_vs_company_cnpj" };
  if (ml.length !== 14) return { ok: false, reason: "ml_document_unknown_shape" };
  if (ml !== co) return { ok: false, reason: "cnpj_mismatch" };
  return { ok: true, reason: "cnpj_match" };
}
