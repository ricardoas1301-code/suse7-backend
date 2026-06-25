// ======================================================================
// Resolver de CEP — billing cartão (prioriza empresa principal)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { normalizeCardHolderPostalCode, onlyDigits } from "./billingCardPostalCode.js";

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function isPrimarySellerCompany(row) {
  if (!row || typeof row !== "object") return false;
  if (row.is_primary === true) return true;
  if (row.is_main === true) return true;
  if (row.principal === true) return true;
  if (row.main === true) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function isActiveSellerCompany(row) {
  if (!row || typeof row !== "object") return false;
  if (row.active === false) return false;
  if (String(row.status || "").toUpperCase() === "INACTIVE") return false;
  return true;
}

/**
 * @param {import("@supabase/supabase-js").PostgrestError | null | undefined} error
 */
function isMissingColumnError(error) {
  const msg = String(error?.message ?? "").toLowerCase();
  return String(error?.code ?? "") === "42703" || msg.includes("column") || msg.includes("schema cache");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function loadSellerCompaniesForBillingAddress(supabase, userId) {
  const selectVariants = [
    "id, cep, telefone, phone, whatsapp, address_number, numero, is_primary, active, company_name",
    "id, cep, telefone, phone, address_number, is_primary, active",
    "id, cep, address_number, is_primary, active",
    "id, cep, is_primary, active",
  ];

  for (const select of selectVariants) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select(select)
      .eq("user_id", userId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: false });

    if (!error) return Array.isArray(data) ? /** @type {Record<string, unknown>[]} */ (data) : [];
    if (!isMissingColumnError(error)) return [];
  }

  return [];
}

/**
 * @param {{
 *   postal_code?: string;
 *   postalCode?: string;
 *   cep?: string;
 * }} [body]
 * @param {Record<string, unknown> | null | undefined} [profile]
 * @param {Record<string, unknown>[]} [sellerCompanies]
 * @param {Record<string, unknown>} [metadata]
 */
export function resolveBillingPostalCodeForCard({
  body = {},
  profile = null,
  sellerCompanies = [],
  metadata = {},
}) {
  const bodyRaw = body.postal_code ?? body.postalCode ?? body.cep;
  const profileRaw = profile?.cep ?? profile?.postal_code;

  const hasBodyPostalCode = normalizeCardHolderPostalCode(bodyRaw) != null;
  const hasProfilePostalCode = normalizeCardHolderPostalCode(profileRaw) != null;

  const activeCompanies = sellerCompanies.filter((row) => isActiveSellerCompany(row));
  const primaryCompany =
    activeCompanies.find((row) => isPrimarySellerCompany(row) && normalizeCardHolderPostalCode(row.cep) != null) ??
    activeCompanies.find((row) => isPrimarySellerCompany(row)) ??
    null;

  const primarySellerCompanyId =
    primaryCompany?.id != null ? String(primaryCompany.id) : null;

  /** @type {Array<{ source: string; value: unknown; company?: Record<string, unknown> }>} */
  const candidates = [{ source: "body", value: bodyRaw }];

  if (primaryCompany) {
    candidates.push({ source: "primary_seller_company", value: primaryCompany.cep, company: primaryCompany });
  }

  candidates.push({ source: "profile", value: profileRaw });

  for (const company of activeCompanies) {
    if (primaryCompany && company.id === primaryCompany.id) continue;
    candidates.push({ source: "seller_company", value: company.cep, company });
  }

  candidates.push({ source: "metadata", value: metadata.cep ?? metadata.postal_code });

  for (const candidate of candidates) {
    const normalized = normalizeCardHolderPostalCode(candidate.value);
    if (!normalized) continue;

    const selectedCompany = candidate.company ?? null;
    return {
      postalCode: normalized,
      postalCodeSource: candidate.source,
      hasBodyPostalCode,
      hasProfilePostalCode,
      sellerCompaniesCount: activeCompanies.length,
      primarySellerCompanyId,
      selectedSellerCompanyId: selectedCompany?.id != null ? String(selectedCompany.id) : null,
      selectedCompanyIsPrimary: selectedCompany ? isPrimarySellerCompany(selectedCompany) : false,
    };
  }

  const profileDigits = onlyDigits(profileRaw);
  const bodyDigits = onlyDigits(bodyRaw);

  return {
    postalCode: "",
    postalCodeSource: null,
    hasBodyPostalCode: bodyDigits.length > 0,
    hasProfilePostalCode: profileDigits.length > 0,
    sellerCompaniesCount: activeCompanies.length,
    primarySellerCompanyId,
    selectedSellerCompanyId: null,
    selectedCompanyIsPrimary: false,
  };
}

/**
 * @param {{
 *   user_id?: string;
 *   plan_key?: string;
 *   card_type?: string;
 *   request_id?: string;
 * }} audit
 * @param {ReturnType<typeof resolveBillingPostalCodeForCard>} resolution
 */
export function logBillingCardPostalCodeResolved(audit, resolution) {
  logBilling("billing", "BILLING_CARD_POSTAL_CODE_RESOLVED", {
    user_id: audit.user_id ?? undefined,
    plan_key: audit.plan_key ?? undefined,
    card_type: audit.card_type ?? undefined,
    request_id: audit.request_id ?? undefined,
    postal_code_source: resolution.postalCodeSource,
    postal_code_length: resolution.postalCode ? resolution.postalCode.length : 0,
    has_body_postal_code: resolution.hasBodyPostalCode,
    has_profile_postal_code: resolution.hasProfilePostalCode,
    seller_companies_count: resolution.sellerCompaniesCount,
    primary_seller_company_id: resolution.primarySellerCompanyId,
    selected_seller_company_id: resolution.selectedSellerCompanyId,
    selected_company_is_primary: resolution.selectedCompanyIsPrimary,
  });
}
