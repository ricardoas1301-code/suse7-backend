// ======================================================
// Avatar admin — identidade do seller por user_id.
// SSOT: logo da empresa principal + profiles.photo_url.
// Multiconta: não escolhe loja/empresa arbitrária.
// ======================================================

import { resolverEmpresaPrincipalOnboarding } from "../../onboarding/domain/avaliarMilestonesConfiguracaoInicial.js";

export const SELLER_COMPANY_AVATAR_SELECTS = [
  "user_id, id, company_name, trade_name, document_cnpj, logo_url, is_primary, active",
  "user_id, id, company_name, trade_name, document_cnpj, logo_url, is_primary",
  "user_id, id, company_name, trade_name, document_cnpj, logo_url",
  "user_id, id, company_name, trade_name, document_cnpj",
];

/**
 * @param {unknown} url
 * @returns {string | null}
 */
export function normalizarUrlAvatarSeller(url) {
  const u = url != null && String(url).trim() !== "" ? String(url).trim() : "";
  if (!u) return null;
  if (u.startsWith("//")) return `https:${u}`;
  if (/^http:\/\//i.test(u)) {
    const lower = u.toLowerCase();
    if (
      lower.includes("mercadolivre") ||
      lower.includes("mercadolibre") ||
      lower.includes("mlstatic") ||
      lower.includes("mlcdn")
    ) {
      return `https://${u.slice(7)}`;
    }
  }
  return u;
}

/**
 * @param {unknown} photoUrl
 * @param {Record<string, unknown>[] | null | undefined} companiesForUser
 * @returns {string | null}
 */
export function resolverUrlAvatarSellerAdmin(photoUrl, companiesForUser) {
  const { company, ambiguous } = resolverEmpresaPrincipalOnboarding(
    Array.isArray(companiesForUser) ? companiesForUser : [],
  );
  const logoPrincipal =
    !ambiguous && company?.logo_url != null && String(company.logo_url).trim() !== ""
      ? String(company.logo_url).trim()
      : "";
  const photo = photoUrl != null && String(photoUrl).trim() !== "" ? String(photoUrl).trim() : "";
  return normalizarUrlAvatarSeller(logoPrincipal || photo || null);
}

/**
 * @param {unknown[]} rows
 * @returns {Map<string, Record<string, unknown>[]>}
 */
export function agruparEmpresasPorSeller(rows) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const uid = row.user_id != null ? String(row.user_id) : "";
    if (!uid) continue;
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid)?.push(/** @type {Record<string, unknown>} */ (row));
  }
  return map;
}
