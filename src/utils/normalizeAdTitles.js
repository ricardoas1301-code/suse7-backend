// ======================================================================
// SUSE7 — normalizeAdTitles
// Normalização segura de ad_titles (backend-only)
// Regras:
// - Aceita array | string JSON | null
// - Limita a 10 itens
// - Garante mínimo 1 item
// - NÃO valida duplicidade (regra de ML será aplicada no fluxo de anúncios)
// ======================================================================

/**
 * Normaliza lista de títulos do anúncio para persistência.
 * @param {unknown} input - array, string JSON ou null
 * @returns {{ id: string; value: string }[]}
 */
export function normalizeAdTitles(input) {
  let arr = [];

  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === "string" && input.trim()) {
    try {
      const parsed = JSON.parse(input);
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      arr = [];
    }
  }

  const result = [];
  for (const item of arr) {
    const value = String(item?.value ?? item ?? "").trim();
    if (value === "") continue;

    const id = String(item?.id || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t_${Date.now()}_${Math.random().toString(36).slice(2)}`));
    result.push({ id, value });
    if (result.length >= 10) break;
  }

  // Garantir mínimo 1 item
  if (result.length === 0) {
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    result.push({ id, value: "" });
  }

  return result;
}
