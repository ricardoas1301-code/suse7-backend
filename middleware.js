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

const ALLOWED_ORIGINS = new Set([
  "https://suse7.com.br",
  "https://www.suse7.com.br",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function corsHeaders(origin) {
  const headers = {};
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
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
