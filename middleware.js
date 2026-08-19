// ==================================================
// SUSE7 — Edge Middleware CORS (Vercel)
// Responde OPTIONS na borda com 204 + headers CORS
// Evita bloqueio do Deployment Protection no preflight
//
// IMPORTANTE: manter paridade com src/middlewares/cors.js (allowlist + env).
// Origens DEV/localhost entram via CORS_ALLOWED_ORIGINS por ambiente — não hard-code cross-env.
// ==================================================

import { next } from "@vercel/functions";

const STATIC_ALLOWED_ORIGINS = new Set([
  "https://suse7.com.br",
  "https://www.suse7.com.br",
]);

/**
 * @returns {Set<string>}
 */
function getAllowedOrigins() {
  const allowed = new Set(STATIC_ALLOWED_ORIGINS);
  const extraRaw = [process.env.CORS_ALLOWED_ORIGINS, process.env.CORS_ORIGINS]
    .filter(Boolean)
    .join(",");
  if (extraRaw.trim()) {
    for (const o of extraRaw.split(",")) {
      const t = o.trim();
      if (t) allowed.add(t);
    }
  }
  return allowed;
}

/**
 * @param {string | null} origin
 * @param {Set<string>} allowedOrigins
 */
function corsHeaders(origin, allowedOrigins) {
  /** @type {Record<string, string>} */
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Trace-Id, X-Job-Secret",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

export const config = {
  matcher: "/api/:path*",
};

export default function middleware(request) {
  const origin = request.headers.get("origin");
  const allowedOrigins = getAllowedOrigins();
  const headers = corsHeaders(origin, allowedOrigins);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  return next({ headers });
}
