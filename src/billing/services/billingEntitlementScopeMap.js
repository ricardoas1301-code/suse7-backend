// ======================================================================
// Mapa scope → capability — SSOT compartilhado (S1.HF.6.9)
// ======================================================================

import { BILLING_ENTITLEMENT_CAPABILITY } from "../billingConstants.js";

/** Mapeamento endpoint/categoria → capability exigida. */
export const BILLING_GATE_CAPABILITY_BY_SCOPE = /** @type {const} */ ({
  sales_list: BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_LISTS,
  sales_detail: BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_DETAILS,
  sales_rayx: BILLING_ENTITLEMENT_CAPABILITY.VIEW_LIVE_DETAILS,
  listings_list: BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_LISTS,
  listings_rayx: BILLING_ENTITLEMENT_CAPABILITY.VIEW_LIVE_DETAILS,
  pricing_list: BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_LISTS,
  pricing_batch: BILLING_ENTITLEMENT_CAPABILITY.EXECUTE_BATCH_ACTIONS,
  reports: BILLING_ENTITLEMENT_CAPABILITY.RUN_REPORTS,
  exports: BILLING_ENTITLEMENT_CAPABILITY.EXPORT_DATA,
  automations: BILLING_ENTITLEMENT_CAPABILITY.RUN_AUTOMATIONS,
  marketplace_ops: BILLING_ENTITLEMENT_CAPABILITY.CHANGE_MARKETPLACE_DATA,
  active_sync: BILLING_ENTITLEMENT_CAPABILITY.REQUEST_MANUAL_SYNC,
  executive_cards: BILLING_ENTITLEMENT_CAPABILITY.VIEW_EXECUTIVE_CARDS,
  filters_search: BILLING_ENTITLEMENT_CAPABILITY.USE_LIST_FILTERS,
  marketplace_api: BILLING_ENTITLEMENT_CAPABILITY.CALL_MARKETPLACE_APIS,
});

/**
 * @param {string} scope
 */
export function isKnownEntitlementScope(scope) {
  return Object.prototype.hasOwnProperty.call(BILLING_GATE_CAPABILITY_BY_SCOPE, scope);
}
