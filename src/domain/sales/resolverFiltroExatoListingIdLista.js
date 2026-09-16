// ======================================================================
// Filtro exato de anúncio para GET /api/sales (Raio-X do Anúncio).
// Igualdade / IN de IDs canônicos — nunca ILIKE, nunca o parâmetro q.
// ======================================================================

const MAX_LISTING_ID_LEN = 80;

/**
 * Variantes exatas do identificador (prefixo ML vs dígitos).
 * Espelha a equivalência já usada no frontend (normalizarListingIdParaMatch)
 * e em expandExternalListingCandidates — sem wildcard.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function expandExactExternalListingIds(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const out = new Set([s]);
  const upper = s.toUpperCase();
  if (/^ML[A-Z]\d+$/.test(upper)) {
    out.add(upper);
    out.add(upper.slice(3));
  }
  if (/^\d+$/.test(s)) {
    out.add(`MLB${s}`);
    out.add(`MLA${s}`);
  }
  return [...out];
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true; ids: string[] } | { ok: false; error: string; ids: string[] }}
 */
export function parseExactExternalListingIdQuery(raw) {
  if (raw == null || String(raw).trim() === "") {
    return { ok: true, ids: [] };
  }
  const s = String(raw).trim();
  if (s.length > MAX_LISTING_ID_LEN) {
    return { ok: false, error: "external_listing_id inválido.", ids: [] };
  }
  if (/[*_%]/.test(s) || /\s/.test(s)) {
    return { ok: false, error: "external_listing_id inválido.", ids: [] };
  }
  const ids = expandExactExternalListingIds(s);
  if (ids.length === 0) {
    return { ok: false, error: "external_listing_id inválido.", ids: [] };
  }
  return { ok: true, ids };
}

/**
 * Interseção: anúncio exato AND (opcional) anúncios do produto.
 * Array vazio = universo vazio. null = sem filtro de listing_id.
 *
 * @param {{
 *   exactListingIds?: string[] | null;
 *   productListingIds?: string[] | null;
 * }} input
 * @returns {string[] | null}
 */
export function mergeListingScopeIds(input = {}) {
  const exact = Array.isArray(input.exactListingIds)
    ? input.exactListingIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const product = Array.isArray(input.productListingIds)
    ? input.productListingIds.map((id) => String(id).trim()).filter(Boolean)
    : [];

  if (exact.length > 0) {
    if (product.length > 0) {
      const allow = new Set(product);
      return exact.filter((id) => allow.has(id));
    }
    return exact;
  }
  if (product.length > 0) return product;
  return null;
}
