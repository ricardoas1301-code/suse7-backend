import Decimal from "decimal.js";
import { isValidCnpjInput, normalizeCnpjDigits } from "../taxIdBr/cnpjDigits.js";

function trimStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

function trimOrNull(v) {
  const t = trimStr(v);
  return t === "" ? null : t;
}

function digitsOnly(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  return d === "" ? null : d;
}

function normalizeEmail(v) {
  const e = trimStr(v).toLowerCase();
  return e === "" ? null : e;
}

/**
 * Normaliza percentual pt-BR/EN para string decimal canônica (2 casas).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeSellerCompanyPercentDecimal(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === "") return null;
  s = s.replace(/%/g, "").trim().replace(/\s/g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(",", ".");
  }
  try {
    const d = new Decimal(s);
    if (!d.isFinite() || d.lt(0) || d.gt(100)) return null;
    return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} body
 * @param {{ includeUndefined?: boolean }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildSellerCompanyWritableFields(body, options = {}) {
  const b = body && typeof body === "object" ? body : {};
  /** @type {Record<string, unknown>} */
  const out = {};

  const set = (key, value) => {
    if (value === undefined && !options.includeUndefined) return;
    out[key] = value;
  };

  if (Object.prototype.hasOwnProperty.call(b, "company_name")) {
    set("company_name", trimOrNull(b.company_name));
  }
  if (Object.prototype.hasOwnProperty.call(b, "trade_name")) {
    set("trade_name", trimOrNull(b.trade_name));
  }
  if (Object.prototype.hasOwnProperty.call(b, "tax_regime")) {
    set("tax_regime", trimOrNull(b.tax_regime));
  }
  if (Object.prototype.hasOwnProperty.call(b, "default_tax_rate")) {
    set("default_tax_rate", normalizeSellerCompanyPercentDecimal(b.default_tax_rate));
  }
  if (Object.prototype.hasOwnProperty.call(b, "operational_cost_rate")) {
    set("operational_cost_rate", normalizeSellerCompanyPercentDecimal(b.operational_cost_rate));
  }
  if (Object.prototype.hasOwnProperty.call(b, "internal_notes")) {
    set("internal_notes", trimOrNull(b.internal_notes));
  }
  if (Object.prototype.hasOwnProperty.call(b, "phone")) {
    set("phone", digitsOnly(b.phone));
  }
  if (Object.prototype.hasOwnProperty.call(b, "whatsapp")) {
    set("whatsapp", digitsOnly(b.whatsapp));
  }
  if (Object.prototype.hasOwnProperty.call(b, "cep")) {
    set("cep", digitsOnly(b.cep));
  }
  if (Object.prototype.hasOwnProperty.call(b, "address_street")) {
    set("address_street", trimOrNull(b.address_street));
  }
  if (Object.prototype.hasOwnProperty.call(b, "address_number")) {
    set("address_number", trimOrNull(b.address_number));
  }
  if (Object.prototype.hasOwnProperty.call(b, "address_complement")) {
    set("address_complement", trimOrNull(b.address_complement));
  }
  if (Object.prototype.hasOwnProperty.call(b, "address_district")) {
    set("address_district", trimOrNull(b.address_district));
  }
  if (Object.prototype.hasOwnProperty.call(b, "address_city")) {
    set("address_city", trimOrNull(b.address_city));
  }
  if (Object.prototype.hasOwnProperty.call(b, "address_state")) {
    const uf = trimStr(b.address_state).toUpperCase().slice(0, 2);
    set("address_state", uf === "" ? null : uf);
  }
  if (Object.prototype.hasOwnProperty.call(b, "logo_url")) {
    set("logo_url", trimOrNull(b.logo_url));
  }
  if (Object.prototype.hasOwnProperty.call(b, "contact_email")) {
    set("contact_email", normalizeEmail(b.contact_email));
  }
  if (Object.prototype.hasOwnProperty.call(b, "active")) {
    set("active", b.active !== false);
  }

  return out;
}

/**
 * @param {Record<string, unknown>} body
 * @returns {{ ok: true } | { ok: false; errors: string[] }}
 */
/**
 * E-mail canônico da sessão autenticada — nunca confiar cegamente no body.
 * @param {unknown} authUserEmail
 * @param {unknown} bodyContactEmail
 */
export function resolveAuthenticatedContactEmail(authUserEmail, bodyContactEmail) {
  const canonical = normalizeEmail(authUserEmail);
  if (!canonical) {
    return {
      ok: false,
      code: "AUTH_EMAIL_MISSING",
      error: "E-mail autenticado indisponível para cadastro da empresa.",
    };
  }

  const requested = normalizeEmail(bodyContactEmail);
  if (requested && requested !== canonical) {
    return {
      ok: false,
      code: "CONTACT_EMAIL_MISMATCH",
      error: "O e-mail da empresa deve ser o e-mail autenticado da conta.",
    };
  }

  return { ok: true, email: canonical };
}

/**
 * Create mínimo do onboarding Configuração Inicial (M1 — Dados da loja).
 * @param {Record<string, unknown>} body
 */
export function validateSellerCompanyConfigurationOnboardingCreateBody(body) {
  const b = body && typeof body === "object" ? body : {};
  /** @type {string[]} */
  const errors = [];

  if (!trimStr(b.company_name)) errors.push("Razão social é obrigatória.");
  if (!trimStr(b.trade_name)) errors.push("Nome fantasia é obrigatório.");

  const doc = normalizeCnpjDigits(String(b.document_cnpj ?? b.document ?? b.cnpj ?? "").replace(/\D/g, ""));
  if (!isValidCnpjInput(doc)) errors.push("CNPJ inválido.");

  const email = normalizeEmail(b.contact_email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("E-mail da empresa é obrigatório.");
  }

  const whatsapp = digitsOnly(b.whatsapp);
  if (!whatsapp) errors.push("WhatsApp é obrigatório.");

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateSellerCompanyCreateBody(body) {
  const b = body && typeof body === "object" ? body : {};
  /** @type {string[]} */
  const errors = [];

  if (!trimStr(b.company_name)) errors.push("Razão social é obrigatória.");
  if (!trimStr(b.trade_name)) errors.push("Nome fantasia é obrigatório.");

  const doc = normalizeCnpjDigits(String(b.document_cnpj ?? b.document ?? b.cnpj ?? "").replace(/\D/g, ""));
  if (!isValidCnpjInput(doc)) errors.push("CNPJ inválido.");

  if (normalizeSellerCompanyPercentDecimal(b.default_tax_rate) == null) {
    errors.push("Alíquota de imposto (%) é obrigatória.");
  }

  const email = normalizeEmail(b.contact_email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("E-mail da empresa é obrigatório.");
  }

  const whatsapp = digitsOnly(b.whatsapp);
  if (!whatsapp) errors.push("WhatsApp é obrigatório.");

  const cep = digitsOnly(b.cep);
  if (!cep || cep.length !== 8) errors.push("CEP inválido.");

  if (!trimStr(b.address_number)) errors.push("Número é obrigatório.");

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * @param {unknown} error
 */
export function isSupabaseMissingColumnError(error) {
  const msg = String(error?.message ?? "").toLowerCase();
  return String(error?.code ?? "") === "42703" || msg.includes("column") || msg.includes("schema cache");
}
