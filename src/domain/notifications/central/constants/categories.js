// =============================================================================
// S7 Central Notification Engine — categorias oficiais (Fase 3.1)
// =============================================================================

/** @type {const} */
export const S7_NOTIFICATION_CATEGORY = Object.freeze({
  BILLING: "BILLING",
  PRODUCTS: "PRODUCTS",
  INVENTORY: "INVENTORY",
  SALES: "SALES",
  PROFIT: "PROFIT",
  MARKETPLACE: "MARKETPLACE",
  ACCOUNT_HEALTH: "ACCOUNT_HEALTH",
  COMPETITION: "COMPETITION",
  SYNC: "SYNC",
  SYSTEM: "SYSTEM",
  DEVCENTER: "DEVCENTER",
});

const CATEGORY_SET = new Set(Object.values(S7_NOTIFICATION_CATEGORY));

/** @param {string} code */
export function isValidNotificationCategory(code) {
  return CATEGORY_SET.has(String(code ?? "").trim());
}
