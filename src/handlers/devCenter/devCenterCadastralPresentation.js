// ======================================================
// Cadastro admin pleno — desmascara só com profiles.is_admin.
// Listas e detalhes usam o mesmo flag. Sem secrets/tokens.
// ======================================================

/**
 * @param {string | null | undefined} raw
 * @param {(value: string | null | undefined) => string | null} maskFn
 * @param {boolean} unmask
 */
export function presentCadastralText(raw, maskFn, unmask) {
  if (raw == null || String(raw).trim() === "") return null;
  if (unmask) return String(raw).trim();
  return maskFn(raw);
}

/**
 * @param {string | null | undefined} raw
 * @param {(value: string | null | undefined) => string | null} maskFn
 * @param {boolean} unmask
 */
export function presentCadastralDocument(raw, maskFn, unmask) {
  if (raw == null || String(raw).trim() === "") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (unmask) return String(raw).trim();
  return maskFn(digits);
}
