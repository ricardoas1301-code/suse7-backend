// ======================================================================
// CARD.CONFIGURATION.ONBOARDING — escopo canônico (01B)
// Híbrido: USER (profiles) + PRIMARY_SELLER_COMPANY (seller_companies)
// ======================================================================

export const ESCOPO_CONFIGURACAO_INICIAL = /** @type {const} */ ({
  KIND: "HYBRID",
  USER_ENTITY: "profiles",
  COMPANY_ENTITY: "seller_companies",
  PRIMARY_COMPANY_SELECTOR: "is_primary=true AND user_id=auth.uid()",
});

export const TOTAL_MILESTONES_CONFIGURACAO = 6;

/** Milestones que bloqueiam o app gate (S1.09 — M6 fora do bloqueio). */
export const TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO = 5;

/**
 * Contrato latch histórico vs projeção (01B.1 + S1.09).
 * - progress/percent: derivado dos milestones *bloqueantes* M1–M5 (nunca persistido como autoridade).
 * - FIRST_MARKETPLACE_CONNECTION (M6): informativo / OT — não bloqueia conclusão da configuração inicial.
 * - initial_configuration_completed_at: latch monotônico ao completar M1–M5.
 * - GET não repara; write paths setam latch na transição real.
 */
export const CONTRATO_LATCH_CONCLUSAO_CONFIGURACAO = /** @type {const} */ ({
  PROGRESS_SOURCE: "BLOCKING_MILESTONES_PROJECTED",
  LATCH_FIELD: "initial_configuration_completed_at",
  BLOCKING_TOTAL: TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO,
  INTERMEDIATE_ALL_BLOCKING_WITHOUT_LATCH: {
    status: "COMPLETED",
    percent: 100,
    completed_at: null,
  },
  GET_REPAIRS_LATCH: false,
});

/**
 * @param {number} completed
 * @param {number} [total]
 */
export function projetarPercentualConfiguracao(
  completed,
  total = TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO,
) {
  const safeTotal = Math.max(1, Number(total) || TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO);
  const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed) || 0));
  return Math.round((safeCompleted / safeTotal) * 100);
}
