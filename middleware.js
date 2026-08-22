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
import {
  buildAllowedOrigins,
  resolvePermittedOrigin,
} from "./src/middlewares/corsAllowlist.js";

const ALLOWED_ORIGINS = buildAllowedOrigins();
const STRICT_LOCAL = process.env.CORS_STRICT_LOCALHOST === "1";

function corsHeaders(origin) {
  const headers = {};
  const permitted = resolvePermittedOrigin(origin, ALLOWED_ORIGINS, {
    strictLocal: STRICT_LOCAL,
  });
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
    // Edge allowlist miss → delega preflight ao handler serverless (applyCors SSOT).
    if (!headers["Access-Control-Allow-Origin"]) {
      return next();
    }
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  return next({ headers });
}
