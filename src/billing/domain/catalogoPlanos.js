// ======================================================================
// Catálogo de planos — regra central de preço e limite (SSOT `public.plans`)
//
// `price_monthly` e `sales_limit_monthly` são a fonte única. Nenhum consumidor
// deve manter constante de código nem valor concorrente para os mesmos dados.
//
// Alcance das fontes (parecer CPF v2, bloqueio 4):
//   * `public.plans` — valor padrão do plano.
//   * `billing_plan_limits` — linha por `plan_id`. Serve para política de aviso
//     e bloqueio e, com marcador explícito, para exceção **global do plano**.
//     Não representa condição individual de seller ou assinatura.
//   * condição individual — vive na assinatura (`billing_subscriptions.metadata`,
//     incluindo o snapshot do ciclo, e as condições comerciais lidas pelo
//     resolvedor de preço de renovação). Nada aqui cria política nova.
// ======================================================================

import Decimal from "decimal.js";

/** Origem do limite mensal efetivo de um plano. */
export const ORIGEM_LIMITE_PLANO = /** @type {const} */ ({
  CATALOGO: "catalogo",
  EXCECAO_GLOBAL_DO_PLANO: "excecao_global_do_plano",
  INDISPONIVEL: "indisponivel",
});

/**
 * Marcadores aceitos em `billing_plan_limits.metadata` para declarar exceção
 * **global do plano**. `commercial_exception` e `limit_override` são grafias
 * legadas do mesmo alcance — nenhuma delas expressa caso individual.
 */
const MARCADORES_EXCECAO_GLOBAL_DO_PLANO = ["excecao_global_do_plano", "commercial_exception", "limit_override"];

/**
 * Exceção global do plano declarada na metadata da linha de limites.
 *
 * @param {unknown} metadataLimite
 */
export function ehExcecaoGlobalDeLimiteDoPlano(metadataLimite) {
  if (!metadataLimite || typeof metadataLimite !== "object") return false;
  const metadata = /** @type {Record<string, unknown>} */ (metadataLimite);
  return MARCADORES_EXCECAO_GLOBAL_DO_PLANO.some((chave) => metadata[chave] === true);
}

/**
 * @param {unknown} valor
 * @returns {number | null}
 */
function normalizarLimite(valor) {
  if (valor == null || valor === "") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

/**
 * Limite mensal efetivo do plano.
 *
 * O catálogo determina o valor padrão. Uma linha de `billing_plan_limits` só
 * prevalece quando declara exceção global do plano na metadata.
 *
 * @param {{
 *   limiteCatalogo?: unknown;
 *   limiteConfigurado?: unknown;
 *   metadataLimite?: unknown;
 * }} entrada
 * @returns {{ limite: number | null; origem: typeof ORIGEM_LIMITE_PLANO[keyof typeof ORIGEM_LIMITE_PLANO] }}
 */
export function resolverLimiteMensalVendas(entrada) {
  const limiteCatalogo = normalizarLimite(entrada?.limiteCatalogo);
  const limiteConfigurado = normalizarLimite(entrada?.limiteConfigurado);

  if (limiteConfigurado != null && ehExcecaoGlobalDeLimiteDoPlano(entrada?.metadataLimite)) {
    return { limite: limiteConfigurado, origem: ORIGEM_LIMITE_PLANO.EXCECAO_GLOBAL_DO_PLANO };
  }
  if (limiteCatalogo != null) {
    return { limite: limiteCatalogo, origem: ORIGEM_LIMITE_PLANO.CATALOGO };
  }
  return { limite: null, origem: ORIGEM_LIMITE_PLANO.INDISPONIVEL };
}

/**
 * Converte o preço mensal decimal em centavos inteiros, sem float.
 *
 * @param {unknown} precoMensal
 * @returns {number | null}
 */
export function converterPrecoMensalParaCentavos(precoMensal) {
  if (precoMensal == null || precoMensal === "") return null;
  let decimal;
  try {
    decimal = new Decimal(String(precoMensal));
  } catch {
    return null;
  }
  if (!decimal.isFinite() || decimal.isNegative()) return null;
  return decimal.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * Normaliza a linha do catálogo para consumo externo.
 *
 * `price_cents` passa a ser derivado de `price_monthly` — compatibilidade de
 * leitura, não preço independente.
 *
 * @template {Record<string, unknown>} T
 * @param {T} plano
 * @returns {T & { price_cents: number | null }}
 */
export function normalizarPlanoParaCatalogo(plano) {
  return {
    ...plano,
    price_cents: converterPrecoMensalParaCentavos(plano?.price_monthly),
  };
}

/** Campos do catálogo que a página pública e o signup podem ver. */
const CAMPOS_PUBLICOS_DO_PLANO = [
  "id",
  "plan_key",
  "slug",
  "name",
  "display_name",
  "marketing_name",
  "price_monthly",
  "price_cents",
  "sales_limit_monthly",
  "sales_range_min",
  "sales_range_max",
  "billing_required",
  "pricing_mode",
  "is_active",
  "sort_order",
];

/**
 * Recorta a linha do catálogo para exposição anônima.
 *
 * @param {Record<string, unknown> | null | undefined} plano
 */
export function projetarCamposPublicosDoPlano(plano) {
  const normalizado = plano ? normalizarPlanoParaCatalogo(plano) : {};
  /** @type {Record<string, unknown>} */
  const publico = {};
  for (const campo of CAMPOS_PUBLICOS_DO_PLANO) {
    if (normalizado[campo] !== undefined) publico[campo] = normalizado[campo];
  }
  return publico;
}
