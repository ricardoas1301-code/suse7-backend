// ==================================================
// SUSE7 — CORS MIDDLEWARE (Vercel)
// Arquivo: src/middlewares/cors.js
//
// Objetivo:
// - Permitir chamadas do Frontend (suse7.com.br) para o Backend (vercel)
// - Responder corretamente o preflight (OPTIONS)
// - Liberar headers necessários (Authorization) para Supabase session token
// ==================================================

export function applyCors(req, res) {
  // ------------------------------
  // ORIGENS PERMITIDAS (Allowlist)
  // ------------------------------
  const allowedOrigins = new Set([
    "https://suse7.com.br",
    "https://www.suse7.com.br",
    "http://localhost:5173",
    "http://localhost:3000",
  ]);

  const origin = req.headers?.origin;

  // ---------------------------------------
  // Define o Access-Control-Allow-Origin
  // ---------------------------------------
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // ---------------------------------------
  // Headers CORS padrão para API com token
  // ---------------------------------------
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-Trace-Id, X-Job-Secret"
  );
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
