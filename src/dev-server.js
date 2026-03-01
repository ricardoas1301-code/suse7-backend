// ==================================================
// SUSE7 — Servidor de desenvolvimento local (DEV)
// Arquivo: src/dev-server.js
//
// Objetivo:
// - Subir servidor HTTP local para desenvolvimento sem Vercel.
// - Repassa todas as requisições /api/* ao handler de api/index.js.
// - Porta: process.env.PORT ou 3001 (frontend já chama localhost:3001).
// - CORS e rotas compatíveis com o entry da Vercel (api/index.js).
// ==================================================

import http from "node:http";

// Handler único da API (mesmo usado na Vercel)
const apiHandler = (await import("../api/index.js")).default;

const PORT = Number(process.env.PORT) || 3001;

// ------------------------------
// Objeto res compatível com api/index.js (setHeader, status, end, json)
// ------------------------------
function createRes(res) {
  const headers = {};
  return {
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      res.statusCode = code;
      return {
        end() {
          Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
          res.end();
        },
        json(obj) {
          Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(obj));
        },
      };
    },
    get statusCode() {
      return res.statusCode;
    },
    set statusCode(v) {
      res.statusCode = v;
    },
    end(...args) {
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      res.end(...args);
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Apenas /api e subcaminhos são repassados ao handler da Vercel
  if (!pathname.startsWith("/api")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found", path: pathname }));
    return;
  }

  // req compatível: host para montar URL no handler
  req.headers = req.headers;
  req.method = req.method;
  req.url = url.pathname + (url.search || "");

  const resCompat = createRes(res);
  try {
    await apiHandler(req, resCompat);
  } catch (err) {
    console.error("[dev-server] handler error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Internal error", errorId: Date.now() }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[S7 Backend DEV] http://localhost:${PORT} (PORT=${PORT})`);
  console.log(`[S7 Backend DEV] GET http://localhost:${PORT}/api/health para health check`);
});
