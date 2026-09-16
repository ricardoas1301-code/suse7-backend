// ======================================================================
// Intenção comercial de plano — chave escolhida no catálogo público
// Distinta do plano efetivo e da recomendação calculada no trial.
// ======================================================================

/**
 * @param {unknown} valor
 * @returns {string | null}
 */
export function normalizarChavePlanoComercial(valor) {
  if (valor == null) return null;
  const texto = String(valor).trim().toLowerCase();
  if (!texto) return null;
  if (texto.length > 64) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(texto)) return null;
  return texto;
}

/**
 * Aceita chave/slug do catálogo. Recusa preço, quota ou estado enviados pelo cliente.
 *
 * @param {unknown} entrada
 * @param {Array<{ plan_key?: unknown; slug?: unknown; id?: unknown; is_active?: unknown }>} planos
 * @returns {{ ok: true; plan_key: string; plan: Record<string, unknown> } | { ok: false; reason: "absent" | "invalid" | "not_in_catalog" }}
 */
export function resolverIntencaoComercialNoCatalogo(entrada, planos) {
  const chave = normalizarChavePlanoComercial(
    entrada && typeof entrada === "object" && !Array.isArray(entrada)
      ? /** @type {Record<string, unknown>} */ (entrada).plan_key ??
          /** @type {Record<string, unknown>} */ (entrada).plan_slug ??
          /** @type {Record<string, unknown>} */ (entrada).slug
      : entrada
  );
  if (!chave) return { ok: false, reason: "absent" };

  const lista = Array.isArray(planos) ? planos : [];
  const encontrado = lista.find((plano) => {
    if (plano?.is_active === false) return false;
    const planKey = normalizarChavePlanoComercial(plano?.plan_key);
    const slug = normalizarChavePlanoComercial(plano?.slug);
    return planKey === chave || slug === chave;
  });
  if (!encontrado) return { ok: false, reason: "not_in_catalog" };
  const planKey = normalizarChavePlanoComercial(encontrado.plan_key) ?? chave;
  return { ok: true, plan_key: planKey, plan: /** @type {Record<string, unknown>} */ (encontrado) };
}
