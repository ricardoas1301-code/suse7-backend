// ======================================================================
// Normalização segura de erros (PostgrestError / objetos plain)
// Nunca serializa tokens, Authorization ou secrets.
// ======================================================================

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} error
 * @param {{ operation?: string | null; errorId?: string | number | null }} [context]
 * @returns {{
 *   message: string;
 *   name: string | null;
 *   code: string | null;
 *   details: string | null;
 *   hint: string | null;
 *   stack: string | null;
 *   operation: string | null;
 *   error_id: string | null;
 *   raw_type: string;
 * }}
 */
export function normalizeBillingError(error, context = {}) {
  const operation = asTrimmedString(context.operation);
  const errorId =
    context.errorId != null && String(context.errorId).trim() !== ""
      ? String(context.errorId)
      : null;

  if (error == null) {
    return {
      message: "unknown_error",
      name: null,
      code: null,
      details: null,
      hint: null,
      stack: null,
      operation,
      error_id: errorId,
      raw_type: "nullish",
    };
  }

  if (typeof error === "string") {
    return {
      message: error.trim() || "unknown_error",
      name: null,
      code: null,
      details: null,
      hint: null,
      stack: null,
      operation,
      error_id: errorId,
      raw_type: "string",
    };
  }

  if (error instanceof Error) {
    const anyErr = /** @type {Error & { code?: unknown; details?: unknown; hint?: unknown }} */ (error);
    return {
      message: asTrimmedString(anyErr.message) || anyErr.name || "Error",
      name: asTrimmedString(anyErr.name),
      code: asTrimmedString(anyErr.code),
      details: asTrimmedString(anyErr.details),
      hint: asTrimmedString(anyErr.hint),
      stack: asTrimmedString(anyErr.stack),
      operation,
      error_id: errorId,
      raw_type: "Error",
    };
  }

  if (typeof error === "object") {
    const obj = /** @type {Record<string, unknown>} */ (error);
    const message =
      asTrimmedString(obj.message) ||
      asTrimmedString(obj.error) ||
      asTrimmedString(obj.msg) ||
      asTrimmedString(obj.reason) ||
      null;
    const code = asTrimmedString(obj.code) ?? asTrimmedString(obj.error_code);
    const details = asTrimmedString(obj.details) ?? asTrimmedString(obj.detail);
    const hint = asTrimmedString(obj.hint);
    const name = asTrimmedString(obj.name);
    const stack = asTrimmedString(obj.stack);

    const composed =
      message ||
      [name, code, details, hint].filter(Boolean).join(" | ") ||
      "non_error_object";

    return {
      message: composed,
      name,
      code,
      details,
      hint,
      stack,
      operation,
      error_id: errorId,
      raw_type: "object",
    };
  }

  return {
    message: String(error),
    name: null,
    code: null,
    details: null,
    hint: null,
    stack: null,
    operation,
    error_id: errorId,
    raw_type: typeof error,
  };
}

/**
 * Texto seguro para persistir em billing_events.processing_error / logs.
 *
 * @param {unknown} error
 * @param {{ operation?: string | null; errorId?: string | number | null }} [context]
 */
export function formatBillingErrorMessage(error, context = {}) {
  const n = normalizeBillingError(error, context);
  const parts = [n.message];
  if (n.code) parts.push(`code=${n.code}`);
  if (n.details) parts.push(`details=${n.details}`);
  if (n.hint) parts.push(`hint=${n.hint}`);
  if (n.operation) parts.push(`op=${n.operation}`);
  return parts.join(" | ").slice(0, 2000);
}

/**
 * @param {unknown} value
 */
export function looksLikeUuid(value) {
  const s = asTrimmedString(value);
  if (!s) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}
