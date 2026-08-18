// ==================================================
// SUSE7 — CORS MIDDLEWARE (Vercel Serverless)
// Arquivo: src/middlewares/cors.js
// SSOT: src/shared/corsContract.js
// ==================================================

import {
  buildCorsResponseHeaders,
  resolvePermittedOrigin,
} from "../shared/corsContract.js";

export function applyCors(req, res) {
  const origin = req.headers?.origin;
  const referer = req.headers?.referer;
  const originPermitida = resolvePermittedOrigin(origin, referer);

  if (req.method === "OPTIONS" && process.env.S7_CORS_DEBUG === "1") {
    console.info("[S7_CORS_DEBUG]", {
      origin: origin ?? null,
      originPermitida: originPermitida ?? null,
      host: req.headers?.host ?? null,
      acrh: req.headers?.["access-control-request-headers"] ?? null,
    });
  }

  const corsHeaders = buildCorsResponseHeaders({
    originPermitida,
    method: req.method,
    accessControlRequestHeaders: req.headers?.["access-control-request-headers"] ?? null,
  });

  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  return false;
}
