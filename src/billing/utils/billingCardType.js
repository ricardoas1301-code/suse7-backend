// ======================================================================
// Tipo de cartão — CREDIT vs DEBIT (persistência segura)
// ======================================================================

/**
 * @param {unknown} value
 * @returns {"CREDIT" | "DEBIT"}
 */
export function normalizePersistedCardType(value) {
  const raw = String(value || "CREDIT").trim().toUpperCase();
  if (raw === "DEBIT" || raw === "DEBIT_CARD") return "DEBIT";
  return "CREDIT";
}

/**
 * @param {"CREDIT" | "DEBIT"} cardType
 */
export function methodTypeFromCardType(cardType) {
  return cardType === "DEBIT" ? "DEBIT_CARD" : "CREDIT_CARD";
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {"CREDIT" | "DEBIT"}
 */
export function cardTypeFromPaymentMethodRow(row) {
  if (!row || typeof row !== "object") return "CREDIT";
  const explicit = normalizePersistedCardType(row.card_type);
  if (row.card_type != null && String(row.card_type).trim() !== "") return explicit;
  const methodType = String(row.method_type || "").toUpperCase();
  if (methodType.includes("DEBIT")) return "DEBIT";
  return "CREDIT";
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function supportsAutoRenewFromPaymentMethodRow(row) {
  if (!row || typeof row !== "object") return false;
  if (typeof row.supports_auto_renew === "boolean") return row.supports_auto_renew;
  return cardTypeFromPaymentMethodRow(row) === "CREDIT";
}
