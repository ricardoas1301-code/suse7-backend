// ======================================================================
// CORS allowlist SSOT — compartilhado entre Edge (middleware.js) e Node (cors.js)
// Sem dependências Node; compatível com Vercel Edge.
// ======================================================================

/** @param {string | undefined} origin */
export function isLocalDevOrigin(origin) {
  if (!origin) return false;
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/** Origens fixas DEV/PROD — manter sincronizado com docs/CORS_OPTIONS_CHECKLIST.md */
export const CORS_STATIC_ALLOWED_ORIGINS = [
  "https://suse7.com.br",
  "https://www.suse7.com.br",
  "https://suse7-frontend-dev.vercel.app",
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
];

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Set<string>}
 */
export function buildAllowedOrigins(env = process.env) {
  const allowed = new Set(CORS_STATIC_ALLOWED_ORIGINS);
  for (const key of ["CORS_ALLOWED_ORIGINS", "CORS_ORIGINS"]) {
    const raw = env?.[key];
    if (!raw) continue;
    for (const part of String(raw).split(",")) {
      const t = part.trim();
      if (t) allowed.add(t);
    }
  }
  return allowed;
}

/**
 * @param {string | null | undefined} origin
 * @param {Set<string>} allowedOrigins
 * @param {{ strictLocal?: boolean }} [options]
 */
export function resolvePermittedOrigin(origin, allowedOrigins, options = {}) {
  if (!origin) return null;
  if (allowedOrigins.has(origin)) return origin;
  const strictLocal = options.strictLocal === true || envStrictLocal(process.env);
  if (!strictLocal && isLocalDevOrigin(origin)) return origin;
  return null;
}

/** @param {Record<string, string | undefined>} [env] */
function envStrictLocal(env) {
  return env?.CORS_STRICT_LOCALHOST === "1";
}
