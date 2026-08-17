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

/**
 * Contrato latch histórico vs projeção (01B.1).
 * - progress/percent: sempre derivado dos milestones (nunca persistido como autoridade).
 * - initial_configuration_completed_at: latch monotônico; quando setado, config permanece 100%.
 * - Estado intermediário 6/6 sem latch: status COMPLETED, percent 100, completed_at null.
 *   GET não repara; write paths futuros devem setar latch na transição real 5/6→6/6.
 */
export const CONTRATO_LATCH_CONCLUSAO_CONFIGURACAO = /** @type {const} */ ({
  PROGRESS_SOURCE: "MILESTONES_PROJECTED",
  LATCH_FIELD: "initial_configuration_completed_at",
  INTERMEDIATE_6_OF_6_WITHOUT_LATCH: {
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
export function projetarPercentualConfiguracao(completed, total = TOTAL_MILESTONES_CONFIGURACAO) {
  const safeTotal = Math.max(1, Number(total) || TOTAL_MILESTONES_CONFIGURACAO);
  const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed) || 0));
  return Math.round((safeCompleted / safeTotal) * 100);
}
