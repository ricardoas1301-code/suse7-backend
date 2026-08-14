// ======================================================================
// Milestones — Configuração Inicial (IDs estáveis para snapshot/API)
// ======================================================================

export const MILESTONE_IDS = /** @type {const} */ ({
  COMPANY_DATA: "COMPANY_DATA",
  LEGAL_ACCEPTANCE: "LEGAL_ACCEPTANCE",
  TAX_RATE: "TAX_RATE",
  OPERATIONAL_COST: "OPERATIONAL_COST",
  OPERATIONAL_CYCLE: "OPERATIONAL_CYCLE",
  FIRST_MARKETPLACE_CONNECTION: "FIRST_MARKETPLACE_CONNECTION",
});

/** @type {readonly (typeof MILESTONE_IDS[keyof typeof MILESTONE_IDS])[]} */
export const MILESTONE_ORDER = [
  MILESTONE_IDS.COMPANY_DATA,
  MILESTONE_IDS.LEGAL_ACCEPTANCE,
  MILESTONE_IDS.TAX_RATE,
  MILESTONE_IDS.OPERATIONAL_COST,
  MILESTONE_IDS.OPERATIONAL_CYCLE,
  MILESTONE_IDS.FIRST_MARKETPLACE_CONNECTION,
];

export const MILESTONE_STATUS = /** @type {const} */ ({
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
});

export const CONFIGURATION_STATUS = /** @type {const} */ ({
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
});
