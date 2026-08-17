// ======================================================================
// Avaliadores puros — milestones Configuração Inicial (sem I/O)
// ======================================================================

import { isValidCnpjInput, normalizeCnpjDigits } from "../../domain/taxIdBr/cnpjDigits.js";
import { normalizeSellerCompanyPercentDecimal } from "../../domain/seller/sellerCompanyRecord.js";
import { validarMetadadosDocumentoLegal } from "../../legal/domain/documentosLegaisCanonicos.js";
import { TERMOS_USO_TIPO_DOCUMENTO } from "../../legal/domain/catalogoDocumentosLegais.js";
import { cicloOperacionalValoresValidos } from "./cicloOperacionalConta.js";

/**
 * @param {Record<string, unknown> | null | undefined} company
 */
export function avaliarMilestoneDadosEmpresa(company) {
  if (!company || typeof company !== "object") {
    return { completed: false, reason: "PRIMARY_COMPANY_MISSING" };
  }

  const companyName = String(company.company_name ?? "").trim();
  const tradeName = String(company.trade_name ?? "").trim();
  const doc = normalizeCnpjDigits(String(company.document_cnpj ?? "").replace(/\D/g, ""));
  const email = String(company.contact_email ?? "").trim().toLowerCase();
  const whatsapp = String(company.whatsapp ?? "").replace(/\D/g, "");

  if (!companyName) return { completed: false, reason: "COMPANY_NAME_MISSING" };
  if (!tradeName) return { completed: false, reason: "TRADE_NAME_MISSING" };
  if (!isValidCnpjInput(doc)) return { completed: false, reason: "CNPJ_INVALID" };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { completed: false, reason: "CONTACT_EMAIL_INVALID" };
  }
  if (!whatsapp) return { completed: false, reason: "WHATSAPP_MISSING" };

  return { completed: true, reason: null };
}

/**
 * @param {Record<string, unknown> | null | undefined} profile
 * @param {Record<string, unknown> | null | undefined} company
 */
export function auditarAssimetriaTelefone(profile, company) {
  const profilePhone = String(profile?.telefone ?? "").replace(/\D/g, "");
  const companyPhone = String(company?.phone ?? "").replace(/\D/g, "");
  return {
    profile_telefone_present: profilePhone.length > 0,
    seller_company_phone_present: companyPhone.length > 0,
    asymmetry_detected: profilePhone.length > 0 && companyPhone.length === 0,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} acceptance
 */
export function avaliarMilestoneAceiteJuridico(acceptance) {
  if (!acceptance) return { completed: false, reason: "LEGAL_ACCEPTANCE_MISSING" };

  const documentType = String(acceptance.document_type ?? "").trim();
  if (documentType !== TERMOS_USO_TIPO_DOCUMENTO) {
    return { completed: false, reason: "TERMS_NOT_ACCEPTED" };
  }
  if (acceptance.scrolled_to_end !== true) {
    return { completed: false, reason: "SCROLL_REQUIRED" };
  }

  const validation = validarMetadadosDocumentoLegal(
    documentType,
    String(acceptance.document_version ?? ""),
    String(acceptance.document_hash ?? ""),
  );
  if (!validation.ok) {
    return { completed: false, reason: validation.code ?? "LEGAL_METADATA_INVALID" };
  }

  return { completed: true, reason: null };
}

/**
 * @param {unknown} rateRaw
 */
export function taxaPercentualExplicitamenteInformada(rateRaw) {
  if (rateRaw == null) return false;
  if (typeof rateRaw === "string" && rateRaw.trim() === "") return false;
  return normalizeSellerCompanyPercentDecimal(rateRaw) != null;
}

/**
 * @param {Record<string, unknown> | null | undefined} company
 */
export function avaliarMilestoneAliquotaImposto(company) {
  if (!taxaPercentualExplicitamenteInformada(company?.default_tax_rate)) {
    return { completed: false, reason: "TAX_RATE_NOT_SET" };
  }
  return { completed: true, reason: null };
}

/**
 * @param {Record<string, unknown> | null | undefined} company
 */
export function avaliarMilestoneCustoOperacional(company) {
  if (!taxaPercentualExplicitamenteInformada(company?.operational_cost_rate)) {
    return { completed: false, reason: "OPERATIONAL_COST_NOT_SET" };
  }
  return { completed: true, reason: null };
}

/**
 * @param {Record<string, unknown> | null | undefined} profile
 */
export function avaliarMilestoneCicloOperacional(profile) {
  const configuredAt = profile?.operational_cycle_configured_at;
  if (configuredAt == null || String(configuredAt).trim() === "") {
    return { completed: false, reason: "OPERATIONAL_CYCLE_NOT_CONFIRMED" };
  }
  if (
    !cicloOperacionalValoresValidos(
      profile?.operational_day_closes_at,
      profile?.operational_working_days,
    )
  ) {
    return { completed: false, reason: "OPERATIONAL_CYCLE_VALUES_INVALID" };
  }
  return { completed: true, reason: null };
}

/**
 * @param {Record<string, unknown> | null | undefined} profile
 */
export function avaliarMilestonePrimeiraIntegracaoMarketplace(profile) {
  const latchedAt = profile?.first_marketplace_connected_at;
  if (latchedAt == null || String(latchedAt).trim() === "") {
    return { completed: false, reason: "FIRST_MARKETPLACE_NOT_LATCHED" };
  }
  return { completed: true, reason: null };
}

/**
 * @param {readonly Record<string, unknown>[]} companies
 */
export function resolverEmpresaPrincipalOnboarding(companies) {
  const rows = Array.isArray(companies) ? companies.filter((c) => c && c.active !== false) : [];
  if (rows.length === 0) {
    return { company: null, ambiguous: false, reason: "NO_COMPANY" };
  }

  const primaries = rows.filter((c) => c.is_primary === true || c.is_primary === "true");
  if (primaries.length === 1) {
    return { company: primaries[0], ambiguous: false, reason: null };
  }
  if (primaries.length > 1) {
    return { company: null, ambiguous: true, reason: "MULTIPLE_PRIMARY_COMPANIES" };
  }
  if (rows.length === 1) {
    return { company: rows[0], ambiguous: false, reason: "SINGLE_COMPANY_FALLBACK" };
  }
  return { company: null, ambiguous: true, reason: "NO_PRIMARY_AND_MULTIPLE_COMPANIES" };
}

/**
 * @param {{ completed: boolean }} m1
 */
export function dependenciaM1ParaM6(m1) {
  return {
    required: true,
    m1_completed: m1.completed === true,
    evidence: [
      "MLConnect.jsx → seller_company_id_required_for_ml_connect",
      "resolveSellerCompanyIdForMlCallback requires seller_companies row",
      "MercadoLivre.jsx → selecionar empresa (CNPJ) antes de OAuth",
    ],
  };
}
