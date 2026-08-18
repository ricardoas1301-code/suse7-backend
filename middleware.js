// ==================================================
// SUSE7 — Edge Middleware CORS (Vercel)
// Responde OPTIONS na borda com 204 + headers CORS (SSOT).
// Evita bloqueio do Deployment Protection no preflight.
// ==================================================

import { next } from "@vercel/functions";
import {
  buildCorsResponseHeaders,
  resolvePermittedOrigin,
} from "./src/shared/corsContract.js";

export const config = {
  matcher: "/api/:path*",
};

/**
 * @param {import("@vercel/functions").Request} request
 */
export default function middleware(request) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const acrh = request.headers.get("access-control-request-headers");
  const originPermitida = resolvePermittedOrigin(origin, referer);
  const headers = buildCorsResponseHeaders({
    originPermitida,
    method: request.method,
    accessControlRequestHeaders: acrh,
  });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  return next({ headers });
}
