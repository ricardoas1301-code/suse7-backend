// ==================================================
// SUSE7 — Edge Middleware CORS (Vercel)
// Responde OPTIONS na borda com 204 + headers CORS
// Evita bloqueio do Deployment Protection no preflight
//
// IMPORTANTE: Se OPTIONS ainda retornar 403, adicione /api ao
// OPTIONS Allowlist em: Settings → Deployment Protection
// Ver: docs/CORS_OPTIONS_CHECKLIST.md
// ==================================================

import { next } from "@vercel/functions";

/** @param {string | undefined} origin */
function isLocalDevOrigin(origin) {
  if (!origin) return false;
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

function buildAllowedOrigins() {
  const allowed = new Set([
    "https://suse7.com.br",
    "https://www.suse7.com.br",
    "https://suse7-frontend-dev.vercel.app",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
  ]);
  for (const key of ["CORS_ALLOWED_ORIGINS", "CORS_ORIGINS"]) {
    const raw = process.env[key];
    if (!raw) continue;
    for (const part of String(raw).split(",")) {
      const t = part.trim();
      if (t) allowed.add(t);
    }
  }
  return allowed;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();
const STRICT_LOCAL = process.env.CORS_STRICT_LOCALHOST === "1";

function resolvePermittedOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (!STRICT_LOCAL && isLocalDevOrigin(origin)) return origin;
  return null;
}

function corsHeaders(origin) {
  const headers = {};
  const permitted = resolvePermittedOrigin(origin);
  if (permitted) {
    headers["Access-Control-Allow-Origin"] = permitted;
  }
  headers["Access-Control-Allow-Credentials"] = "true";
  headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With, X-Trace-Id, X-Job-Secret";
  headers["Access-Control-Max-Age"] = "86400";
  headers["Vary"] = "Origin";
  return headers;
}

export const config = {
  matcher: "/api/:path*",
};

export default function middleware(request) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  return next({ headers });
}
