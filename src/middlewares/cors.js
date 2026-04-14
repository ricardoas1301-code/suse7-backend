// ==================================================
// SUSE7 — CORS MIDDLEWARE (Vercel)
// Arquivo: src/middlewares/cors.js
//
// Objetivo:
// - Permitir chamadas do Frontend (suse7.com.br) para o Backend (vercel)
// - Responder corretamente o preflight (OPTIONS)
// - Liberar headers necessários (Authorization) para Supabase session token
// - Se o POST some após OPTIONS 204: quase sempre falta Access-Control-Allow-Origin
//   no preflight porque Origin não bateu na allowlist (127.0.0.1 vs localhost, porta, etc.)
// ==================================================

/**
 * @param {string | undefined} origin
 */
function isLocalDevOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * @param {import("http").IncomingMessage} req
 */
function buildAllowHeaders(req) {
  const base = [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Trace-Id",
    "X-Job-Secret",
    "Accept",
    "Prefer",
    "Apikey",
    "X-Client-Info",
  ];
  /** @type {Set<string>} */
  const set = new Set(base.map((s) => s.toLowerCase()));
  const acrh = req.headers["access-control-request-headers"];
  if (typeof acrh === "string" && acrh.trim()) {
    for (const part of acrh.split(",")) {
      const t = part.trim();
      if (t) set.add(t.toLowerCase());
    }
  }
  // devolve com capitalização legível nos primeiros; o browser compara case-insensitive
  const ordered = [...set].sort();
  return ordered
    .map((h) =>
      h === "content-type"
        ? "Content-Type"
        : h === "authorization"
          ? "Authorization"
          : h === "x-requested-with"
            ? "X-Requested-With"
            : h === "x-trace-id"
              ? "X-Trace-Id"
              : h === "x-job-secret"
                ? "X-Job-Secret"
                : h === "x-client-info"
                  ? "X-Client-Info"
                  : h === "apikey"
                    ? "Apikey"
                    : h
    )
    .join(", ");
}

export function applyCors(req, res) {
  // ------------------------------
  // ORIGENS PERMITIDAS (Allowlist + CORS_ALLOWED_ORIGINS)
  // ------------------------------
  const allowedOrigins = new Set([
    "https://suse7.com.br",
    "https://www.suse7.com.br",
    "http://localhost:5173",
    "https://localhost:5173",
    "http://localhost:3000",
    "https://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:5173",
    "https://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://[::1]:5173",
    "http://[::1]:3000",
  ]);

  const extraRaw = [process.env.CORS_ALLOWED_ORIGINS, process.env.CORS_ORIGINS]
    .filter(Boolean)
    .join(",");
  if (extraRaw.trim()) {
    for (const o of extraRaw.split(",")) {
      const t = o.trim();
      if (t) allowedOrigins.add(t);
    }
  }

  const origin = req.headers?.origin;
  const strictLocal = process.env.CORS_STRICT_LOCALHOST === "1";

  /** Origem autorizada a receber Access-Control-Allow-Origin espelhado */
  const originPermitida =
    origin && (allowedOrigins.has(origin) || (!strictLocal && isLocalDevOrigin(origin)))
      ? origin
      : null;

  // ---------------------------------------
  // Define o Access-Control-Allow-Origin (obrigatório para o browser prosseguir após OPTIONS)
  // ---------------------------------------
  if (originPermitida) {
    res.setHeader("Access-Control-Allow-Origin", originPermitida);
  }

  // ---------------------------------------
  // Headers CORS padrão para API com token
  // ---------------------------------------
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", buildAllowHeaders(req));
  res.setHeader("Access-Control-Max-Age", "86400");

  // ---------------------------------------
  // PRE-FLIGHT: se for OPTIONS, encerra aqui
  // ---------------------------------------
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  return false;
}
