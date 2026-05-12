// ======================================================================
// Logs padronizados — Billing S7
// ======================================================================

const PREFIX = {
  billing: "[S7_BILLING]",
  webhook: "[S7_BILLING_WEBHOOK]",
  asaas: "[S7_BILLING_ASAAS]",
  access: "[S7_BILLING_ACCESS]",
};

/**
 * @param {string} scope
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
export function logBilling(scope, message, extra) {
  const p = PREFIX[scope] || PREFIX.billing;
  if (extra && Object.keys(extra).length > 0) {
    console.info(`${p} ${message}`, extra);
  } else {
    console.info(`${p} ${message}`);
  }
}

/**
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [err]
 * @param {Record<string, unknown>} [extra]
 */
export function logBillingError(scope, message, err, extra) {
  const p = PREFIX[scope] || PREFIX.billing;
  const payload = {
    ...extra,
    err: err instanceof Error ? err.message : err,
  };
  console.error(`${p} ${message}`, payload);
}
