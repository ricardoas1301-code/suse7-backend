// ======================================================================
// Sanitização — nunca persistir secrets em audit/timeline payload
// ======================================================================

const SECRET_KEY_PATTERN =
  /token|secret|password|api[_-]?key|authorization|credit_card|card_number|cvv|cvc|holder/i;

/**
 * @param {unknown} value
 * @param {number} [depth]
 */
export function sanitizeBillingAuditValue(value, depth = 0) {
  if (depth > 8) return "[max_depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 2000) return `${value.slice(0, 2000)}…`;
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeBillingAuditValue(item, depth + 1));
  }

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizeBillingAuditValue(raw, depth + 1);
  }
  return out;
}
