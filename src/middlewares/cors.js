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
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
    "https://localhost:5173",
    "http://localhost:3000",
    "https://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
    "http://127.0.0.1:5176",
    "https://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://[::1]:5173",
    "http://[::1]:5174",
    "http://[::1]:5175",
    "http://[::1]:5176",
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
  const referer = req.headers?.referer;
  let inferredOrigin = null;
  if (!origin && typeof referer === "string" && referer.trim()) {
    try {
      const u = new URL(referer);
      inferredOrigin = `${u.protocol}//${u.host}`;
    } catch {
      inferredOrigin = null;
    }
  }
  const strictLocal = process.env.CORS_STRICT_LOCALHOST === "1";

  /** Origem autorizada a receber Access-Control-Allow-Origin espelhado */
  const originCandidate = origin ?? inferredOrigin;
  const originPermitida =
    originCandidate &&
    (allowedOrigins.has(originCandidate) || (!strictLocal && isLocalDevOrigin(originCandidate)))
      ? originCandidate
      : null;

  if (req.method === "OPTIONS" && process.env.S7_CORS_DEBUG === "1") {
    console.info("[S7_CORS_DEBUG]", {
      origin: origin ?? null,
      strictLocal,
      originPermitida: originPermitida ?? null,
      host: req.headers?.host ?? null,
      acrh: req.headers?.["access-control-request-headers"] ?? null,
    });
  }

  // ---------------------------------------
  // Define o Access-Control-Allow-Origin (obrigatório para o browser prosseguir após OPTIONS)
  // ---------------------------------------
  if (originPermitida) {
    res.setHeader("Access-Control-Allow-Origin", originPermitida);
  } else if (req.method === "OPTIONS") {
    /**
     * Hotfix DEV: alguns clientes (e alguns proxies) podem omitir `Origin` no preflight.
     * Sem Allow-Origin o browser aborta o request real (especialmente quando há Authorization header).
     * Para OPTIONS sem Origin em ambiente de dev/local, liberamos *sem credenciais*.
     */
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  // ---------------------------------------
  // Headers CORS padrão para API com token
  // ---------------------------------------
  res.setHeader("Vary", "Origin");
  if (!(req.method === "OPTIONS" && !originPermitida)) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
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
