// ======================================================================
// SUSE7 — CORS Helper (global para /api/*)
// Origens via ENV: CORS_ORIGINS="https://suse7.com.br,http://localhost:5173,..."
// OPTIONS preflight: 204 + headers. Requests normais: Access-Control-Allow-Origin + Vary
// ======================================================================

import { config } from "../infra/config.js";

// ----------------------------------------------------------------------
// Origens permitidas (CORS_ORIGINS ou CORS_ALLOWED_ORIGINS)
// CORS_ORIGINS="https://suse7.com.br,http://localhost:5173,http://localhost:3000"
// ----------------------------------------------------------------------
const DEFAULT_ORIGINS = [
  "https://suse7.com.br",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getAllowedOrigins() {
  const fromEnv = config.corsOrigins?.length ? config.corsOrigins : config.corsAllowedOrigins;
  if (fromEnv?.length) return fromEnv;
  return DEFAULT_ORIGINS;
}

/**
 * Define headers CORS no response.
 * Só define Access-Control-Allow-Origin se origin estiver na allowlist.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export function setCorsHeaders(req, res) {
  const origins = getAllowedOrigins();
  const origin = req?.headers?.origin;

  if (origin && origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (origin && process.env.NODE_ENV === "development") {
    // Log curto em dev se origin bloqueada (sem vazar dados)
    console.warn("[cors] Origin bloqueada (dev)");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Trace-Id, X-Job-Secret"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Responde ao preflight OPTIONS com 204.
 * Chamar no início do handler, antes de qualquer lógica.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @returns {boolean} true se era OPTIONS e já respondeu
 */
export function handlePreflight(req, res) {
  if (req?.method === "OPTIONS") {
    setCorsHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

/**
 * Wrapper: aplica CORS + preflight no início do handler.
 * Uso: export default withCors(async (req, res) => { ... })
 */
export function withCors(handler) {
  return async (req, res) => {
    setCorsHeaders(req, res);
    if (handlePreflight(req, res)) return;
    return handler(req, res);
  };
}
