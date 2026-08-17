// ======================================================================
// Mercado Livre — limites de fotos por categoria (settings ML)
// Reutilizado pelo Raio-X do Anúncio e sync de imagens produto → anúncio.
// ======================================================================

const ML_API = "https://api.mercadolibre.com";

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/**
 * @param {unknown} value
 */
function numeroPositivoOuNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * @param {Record<string, unknown>} categoryJson
 */
export function extractCategoryPictureLimits(categoryJson) {
  const settings =
    categoryJson?.settings != null && typeof categoryJson.settings === "object"
      ? /** @type {Record<string, unknown>} */ (categoryJson.settings)
      : null;

  return {
    max_pictures_per_item: settings ? numeroPositivoOuNull(settings.max_pictures_per_item) : null,
    max_pictures_per_item_var: settings ? numeroPositivoOuNull(settings.max_pictures_per_item_var) : null,
    category_name: textoOuNull(categoryJson?.name),
  };
}

/**
 * @param {string} accessToken
 * @param {string} categoryId
 * @param {Map<string, Record<string, unknown> | null>} [categoryCache]
 */
export async function fetchMercadoLivreCategoryJson(accessToken, categoryId, categoryCache) {
  const id = textoOuNull(categoryId);
  const token = textoOuNull(accessToken);
  if (!id || !token) return null;

  if (categoryCache?.has(id)) {
    return categoryCache.get(id) ?? null;
  }

  /** @type {Record<string, unknown> | null} */
  let result = null;
  try {
    const url = `${ML_API}/categories/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json && typeof json === "object" && !Array.isArray(json)) {
      result = /** @type {Record<string, unknown>} */ (json);
    }
  } catch {
    result = null;
  }

  categoryCache?.set(id, result);
  return result;
}
