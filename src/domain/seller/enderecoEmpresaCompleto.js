/**
 * Endereço mínimo canônico da empresa — alinhado ao cadastro (CEP + logradouro + número + cidade + UF).
 * @param {Record<string, unknown> | null | undefined} company
 */
export function enderecoEmpresaMinimoCompleto(company) {
  if (!company || typeof company !== "object") return false;

  const cep = String(company.cep ?? "").replace(/\D/g, "");
  const street = String(company.address_street ?? "").trim();
  const number = String(company.address_number ?? "").trim();
  const city = String(company.address_city ?? "").trim();
  const state = String(company.address_state ?? "").trim().toUpperCase();

  return (
    cep.length === 8 &&
    street.length > 0 &&
    number.length > 0 &&
    city.length > 0 &&
    state.length >= 2
  );
}

/**
 * Avatar/logo da loja presente — SSOT empresa (logo_url) com fallback espelho em profile (photo_url).
 * @param {{ companyLogoUrl?: string | null; profilePhotoUrl?: string | null }} input
 */
export function avatarLojaPresente(input = {}) {
  const logo = input.companyLogoUrl != null ? String(input.companyLogoUrl).trim() : "";
  const photo = input.profilePhotoUrl != null ? String(input.profilePhotoUrl).trim() : "";
  return logo.length > 0 || photo.length > 0;
}
