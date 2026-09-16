// ======================================================================
// Recomendação de plano a partir dos pedidos do trial (CPS 1 / T3)
// Projeção é estimativa; não altera plano nem cobra.
// ======================================================================

import Decimal from "decimal.js";

export const DIAS_BASE_TRIAL_RECOMENDACAO = 15;
export const CHAVE_PLANO_SOB_CONSULTA = "infinity";

/**
 * @param {unknown} valor
 * @returns {number}
 */
function inteiroNaoNegativo(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) return 0;
  return Math.floor(numero);
}

/**
 * @param {unknown} limite
 * @returns {number | null}
 */
export function lerLimiteNumericoDoPlano(limite) {
  if (limite == null || limite === "") return null;
  const numero = Number(limite);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return numero;
}

/**
 * Média e projeções do T3. Sempre divide pelos 15 dias do trial, não pelos dias decorridos.
 *
 * @param {{ pedidosTrial?: unknown; diasBase?: number }} entrada
 */
export function calcularProjecaoPedidosTrial(entrada = {}) {
  const pedidos = inteiroNaoNegativo(entrada.pedidosTrial);
  const diasBase = inteiroNaoNegativo(entrada.diasBase) || DIAS_BASE_TRIAL_RECOMENDACAO;
  const mediaDiaria = new Decimal(pedidos).div(diasBase);
  const projecaoProximos = mediaDiaria.mul(diasBase);
  const projecaoMensal = new Decimal(pedidos).plus(projecaoProximos);
  return {
    trial_orders: pedidos,
    trial_days: diasBase,
    daily_average: mediaDiaria.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
    next_15_days_projection: projecaoProximos.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
    monthly_projection: projecaoMensal.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
    is_estimate: true,
  };
}

/**
 * Menor plano cujo limite numérico comporta a projeção. Sem limite numérico → sob consulta.
 *
 * @param {{
 *   projecaoMensal: number;
 *   planos: Array<{ plan_key?: unknown; slug?: unknown; sales_limit_monthly?: unknown; pricing_mode?: unknown; sort_order?: unknown }>;
 * }} entrada
 */
export function selecionarPlanoRecomendadoPelaProjecao(entrada) {
  const projecao = Number(entrada?.projecaoMensal);
  const planos = Array.isArray(entrada?.planos) ? entrada.planos : [];
  const comLimite = planos
    .map((plano) => ({
      plan_key: String(plano.plan_key ?? plano.slug ?? "").trim().toLowerCase(),
      sales_limit_monthly: lerLimiteNumericoDoPlano(plano.sales_limit_monthly),
      sort_order: Number.isFinite(Number(plano.sort_order)) ? Number(plano.sort_order) : Number.MAX_SAFE_INTEGER,
    }))
    .filter((plano) => plano.plan_key && plano.sales_limit_monthly != null)
    .sort((a, b) => a.sales_limit_monthly - b.sales_limit_monthly || a.sort_order - b.sort_order);

  if (!Number.isFinite(projecao) || projecao < 0) {
    return { recommended_plan_key: null, recommended_is_quote: false, reason: "projection_unavailable" };
  }

  const cabivel = comLimite.find((plano) => projecao <= plano.sales_limit_monthly);
  if (cabivel) {
    return {
      recommended_plan_key: cabivel.plan_key,
      recommended_is_quote: false,
      matching_limit: cabivel.sales_limit_monthly,
      reason: "smallest_numeric_limit",
    };
  }

  const sobConsulta =
    planos.find((plano) => String(plano.plan_key ?? "").toLowerCase() === CHAVE_PLANO_SOB_CONSULTA) ??
    planos.find((plano) => String(plano.pricing_mode ?? "").toLowerCase() === "quote");

  return {
    recommended_plan_key: String(sobConsulta?.plan_key ?? CHAVE_PLANO_SOB_CONSULTA).toLowerCase(),
    recommended_is_quote: true,
    matching_limit: null,
    reason: "exceeds_numeric_plans",
  };
}

/**
 * @param {{
 *   pedidosTrial: number;
 *   planos: Array<Record<string, unknown>>;
 *   periodComplete?: boolean;
 *   collectionComplete?: boolean;
 *   chosenPlanKey?: string | null;
 * }} entrada
 */
export function montarRecomendacaoPlanoTrial(entrada) {
  const projecao = calcularProjecaoPedidosTrial({ pedidosTrial: entrada.pedidosTrial });
  const selecao = selecionarPlanoRecomendadoPelaProjecao({
    projecaoMensal: projecao.monthly_projection,
    planos: entrada.planos,
  });
  const periodComplete = entrada.periodComplete === true;
  const collectionComplete = entrada.collectionComplete !== false;
  const isDefinitive = periodComplete && collectionComplete;
  return {
    chosen_plan_key: entrada.chosenPlanKey ?? null,
    recommended_plan_key: selecao.recommended_plan_key,
    recommended_is_quote: Boolean(selecao.recommended_is_quote),
    recommendation_reason: selecao.reason,
    matching_limit: selecao.matching_limit ?? null,
    projection: {
      ...projecao,
      period_complete: periodComplete,
      collection_complete: collectionComplete,
      is_definitive: isDefinitive,
      presentation_label: isDefinitive
        ? "Estimativa com base nos 15 dias de teste"
        : "Estimativa — período ou coleta ainda incompletos",
    },
  };
}
