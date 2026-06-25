// ======================================================================
// Asaas — validação de autenticidade do webhook (token compartilhado)
// ======================================================================

/**
 * @param {import("http").IncomingMessage & { body?: unknown; bodyBuffer?: Buffer }} req
 * @param {string} expectedToken
 */
export function validateAsaasWebhookToken(req, expectedToken) {
  const exp = String(expectedToken || "").trim();
  if (!exp) return false;

  const h1 = req.headers["asaas-access-token"] || req.headers["Asaas-Access-Token"];
  if (typeof h1 === "string" && h1.trim() === exp) return true;

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.slice(7).trim() === exp) return true;

  const rawPath = typeof req.url === "string" ? req.url : "";
  try {
    const host = req.headers?.host ? String(req.headers.host) : "localhost";
    const base = rawPath.startsWith("http") ? rawPath : `http://${host}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`;
    const u = new URL(base);
    const q = u.searchParams.get("access_token");
    if (q && q.trim() === exp) return true;
  } catch {
    /* ignore */
  }

  return false;
}
