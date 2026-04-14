// ======================================================
// Rótulo de tarifa de venda (tipo ML + %) — genérico, sem depender da grid.
// ======================================================

/**
 * @param {string | null | undefined} listingTypeId
 * @returns {{ label: string | null; raw: string | null }}
 */
function normalizeListingTypeId(listingTypeId) {
  if (listingTypeId == null || String(listingTypeId).trim() === "") {
    return { label: null, raw: null };
  }
  const raw = String(listingTypeId).trim();
  const id = raw.toLowerCase();
  if (id === "gold_special" || id === "special") return { label: "Clássico", raw };
  if (id === "gold_pro" || id === "gold_premium" || id === "pro") return { label: "Premium", raw };
  if (id === "free") return { label: "Grátis", raw };
  return { label: null, raw };
}

/**
 * @param {string | null | undefined} percentFixed2Str — ex.: "16.50"
 * @returns {string | null} — ex.: "16,50%"
 */
function formatPercentPtBr(percentFixed2Str) {
  if (percentFixed2Str == null || String(percentFixed2Str).trim() === "") return null;
  const n = Number(String(percentFixed2Str).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/**
 * Subtítulo da tarifa (ex.: "Premium 16,50%"). Sem %, retorna só o tipo quando existir.
 *
 * @param {string | null | undefined} listingTypeId
 * @param {string | null | undefined} percentFixed2Str
 * @returns {string | null}
 */
export function formatMercadoLivreSaleFeeLabel(listingTypeId, percentFixed2Str) {
  const { label } = normalizeListingTypeId(listingTypeId);
  const pct = formatPercentPtBr(percentFixed2Str);
  if (label && pct) return `${label} ${pct}`;
  if (pct) return pct;
  return label;
}
