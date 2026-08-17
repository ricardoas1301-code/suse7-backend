// =============================================================================
// Dev Center S_4.8.4 — normalização e validação de inputs (customers-global)
// =============================================================================

/** Alinhado com limite de slice da listagem (200) + margem para busca. */
export const CUSTOMERS_GLOBAL_SEARCH_MAX_LEN = 120;

export const CUSTOMERS_GLOBAL_ID_MAX_LEN = 36;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Busca q — trim, lowercase, collapse whitespace, cap length. Sem regex pesada.
 * @param {unknown} raw
 */
export function normalizeCustomersGlobalSearchQuery(raw) {
  if (raw == null) return "";
  let s = String(raw).trim().toLowerCase();
  if (!s) return "";
  if (s.length > CUSTOMERS_GLOBAL_SEARCH_MAX_LEN) {
    s = s.slice(0, CUSTOMERS_GLOBAL_SEARCH_MAX_LEN);
  }
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * @param {unknown} raw
 */
export function isValidGlobalCustomerId(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > CUSTOMERS_GLOBAL_ID_MAX_LEN) return false;
  return UUID_RE.test(s);
}

/** Summary mínimo quando agregação falha — contrato estável. */
export function buildFallbackAdminGlobalSummary(listedCount = 0) {
  return {
    scope: "admin_global",
    total_customers: listedCount,
    listed_customers: listedCount,
    incomplete_contact: null,
    ingestion_health: null,
    data_quality_overview: null,
  };
}
