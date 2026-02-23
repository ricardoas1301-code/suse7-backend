// ======================================================================
// SUSE7 — HTTP Helpers
// Padronização de respostas (ok/fail) e traceId por request
// ======================================================================

/**
 * Gera ou obtém traceId do request.
 * Usa x-trace-id do header se presente; senão gera UUID.
 * @param {import("http").IncomingMessage} req
 * @returns {string}
 */
export function getTraceId(req) {
  const header = req?.headers?.["x-trace-id"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Resposta de sucesso padronizada.
 * @param {import("http").ServerResponse} res
 * @param {object} data - payload da resposta
 * @param {number} [status=200]
 */
export function ok(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

/**
 * Resposta de erro padronizada.
 * Estrutura: { code, message, details?, traceId }
 * @param {import("http").ServerResponse} res
 * @param {{ code: string; message: string; details?: unknown }} payload
 * @param {number} [status=400]
 * @param {string} [traceId]
 */
export function fail(res, { code, message, details }, status = 400, traceId = null) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const body = {
    code,
    message,
    ...(details != null ? { details } : {}),
    ...(traceId ? { traceId } : {}),
  };
  res.end(JSON.stringify(body));
}
