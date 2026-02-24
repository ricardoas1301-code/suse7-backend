// ==================================================
// SUSE7 — WRAPPER UNIVERSAL CORS (Serverless)
// Arquivo: src/utils/withCors.js
// ==================================================

export function withCors(handler) {
  return async (req, res) => {
    const allowedOrigins = new Set([
      "https://suse7.com.br",
      "https://www.suse7.com.br",
      "http://localhost:5173",
      "http://localhost:3000",
    ]);

    const origin = req.headers?.origin;

    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }

    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, X-Trace-Id, X-Job-Secret"
    );

    // Preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    return handler(req, res);
  };
}
