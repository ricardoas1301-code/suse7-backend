// ======================================================================
// Helpers Asaas — base URL e erros sanitizados (sem secrets)
// ======================================================================

const SANDBOX_BASE_URL = "https://api-sandbox.asaas.com/v3";
const PRODUCTION_BASE_URL = "https://api.asaas.com/v3";

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {string} raw
 * @param {string} env
 */
export function normalizeAsaasApiBaseUrl(raw, env = "sandbox") {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (trimmed) {
    if (trimmed === "https://sandbox.asaas.com/api/v3") {
      return SANDBOX_BASE_URL;
    }
    return trimmed;
  }

  const normalizedEnv = String(env || "sandbox").trim().toLowerCase();
  if (normalizedEnv === "production" || normalizedEnv === "prod") {
    return PRODUCTION_BASE_URL;
  }
  return SANDBOX_BASE_URL;
}

/**
 * @param {unknown} body
 */
export function summarizeAsaasErrorBody(body) {
  const obj = asObject(body);
  if (!obj) {
    return { message: typeof body === "string" ? body.slice(0, 200) : null, errors: [] };
  }

  const errors = Array.isArray(obj.errors) ? obj.errors : [];
  /** @type {Array<{ code: string | null; description: string | null }>} */
  const summarized = [];
  for (const item of errors) {
    const row = asObject(item);
    if (!row) continue;
    summarized.push({
      code: typeof row.code === "string" ? row.code : null,
      description: typeof row.description === "string" ? row.description : null,
    });
    if (summarized.length >= 5) break;
  }

  const firstDescription = summarized.find((entry) => entry.description)?.description ?? null;
  return {
    message: firstDescription,
    errors: summarized,
  };
}
