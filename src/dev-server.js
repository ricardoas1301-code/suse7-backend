// ==================================================
// SUSE7 — Servidor de desenvolvimento local (DEV)
// Arquivo: src/dev-server.js
//
// Objetivo:
// - Subir servidor HTTP local para desenvolvimento sem Vercel.
// - Repassa todas as requisições /api/* ao handler de api/index.js.
// - Porta: process.env.PORT ou 3001 (frontend já chama localhost:3001).
// - CORS e rotas compatíveis com o entry da Vercel (api/index.js).
// - Carrega .env / .env.local da raiz do pacote (backendRoot), depois isolamento DEV.
// ==================================================

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import http from "node:http";

import { applyDevServerEnvIsolation } from "./infra/devEnvIsolation.js";
import {
  validateMlConnectOAuthEnv,
  classifyMlOAuthRedirect,
  getMlOAuthRuntimeLabel,
  maskMlClientIdForLog,
} from "./handlers/ml/_helpers/oauthConnect.js";

/** Raiz do pacote suse7-backend (pasta do package.json), independente do cwd. */
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.local"), override: true });

const PORT = Number(process.env.PORT) || 3001;

applyDevServerEnvIsolation(PORT);

const feBoot = (process.env.FRONTEND_URL || "").trim();
const ruBoot = (process.env.ML_REDIRECT_URI || "").trim();
const mlIdBoot = (process.env.ML_CLIENT_ID || "").trim();
const mlSecBoot = (process.env.ML_CLIENT_SECRET || "").trim();

console.log("[BOOT] backendRoot:", backendRoot);
console.log("[BOOT] dotenv files:", path.join(backendRoot, ".env"), "|", path.join(backendRoot, ".env.local"));
console.log("[BOOT] FRONTEND_URL:", feBoot || "(vazio)");
console.log("[BOOT] ML_REDIRECT_URI:", ruBoot || "(vazio)");
console.log("[BOOT] ML_CLIENT_ID length:", mlIdBoot.length, "| preview:", maskMlClientIdForLog(mlIdBoot));
console.log("[BOOT] ML OAuth env (rótulo):", getMlOAuthRuntimeLabel(), "| NODE_ENV:", process.env.NODE_ENV ?? "(unset)");
console.log("[BOOT] ML_CLIENT_SECRET length:", mlSecBoot.length);
console.log("[BOOT] PORT:", PORT);

const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
console.log(
  "[BOOT] SUPABASE_URL:",
  supabaseUrl.length > 24 ? `${supabaseUrl.slice(0, 16)}…${supabaseUrl.slice(-10)}` : supabaseUrl || "(vazio)"
);
console.log("[BOOT] SUPABASE_SERVICE_ROLE_KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "***definido***" : "(vazio)");

const bootReq = /** @type {{ headers: { host: string } }} */ ({
  headers: { host: `localhost:${PORT}` },
});
const mlVal = validateMlConnectOAuthEnv(bootReq);
if (!mlVal.ok) {
  console.error("[ML_CONFIG_ERROR] invalid OAuth environment configuration");
  for (const line of mlVal.errors) {
    console.error("[ML_CONFIG_ERROR]", line);
  }
  console.error(
    "[ML_CONFIG_ERROR] Corrija o .env ou .env.local na raiz do suse7-backend e reinicie. Opcional: SUSE7_STRICT_ML_CONFIG=1 para encerrar o processo quando inválido."
  );
  if (process.env.SUSE7_STRICT_ML_CONFIG === "1") {
    console.error("[BOOT] SUSE7_STRICT_ML_CONFIG=1 — encerrando (OAuth inválido)");
    process.exit(1);
  }
} else {
  console.log("[BOOT] ML OAuth env: ok (validateMlConnectOAuthEnv)");
}

{
  const { isLocalRedirect, oauthMode } = classifyMlOAuthRedirect(ruBoot);
  if (oauthMode === "local") {
    console.warn(
      "[BOOT] ML_REDIRECT_URI é localhost — só use se estiver cadastrada no app ML; caso contrário use HTTPS (ex.: deploy dev) e a mesma URI no .env e no painel."
    );
  }
  console.log("[BOOT] ML OAuth redirect class:", { isLocalRedirect, oauthMode });
}

const apiHandler = (await import("../api/index.js")).default;

function createRes(res) {
  const headers = {};
  return {
    setHeader(name, value) {
      headers[name] = value;
    },
    /**
     * Compat Express: vários handlers usam res.json(body) sem res.status() prévio.
     * @param {unknown} obj
     */
    json(obj) {
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (!res.statusCode || res.statusCode < 200) res.statusCode = 200;
      res.end(JSON.stringify(obj));
    },
    status(code) {
      res.statusCode = code;
      /** @type {{ end: () => void; json: (obj: unknown) => void; redirect: (location: string) => void }} */
      const chain = {
        end() {
          Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
          res.end();
        },
        json(obj) {
          Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(obj));
        },
        redirect(location) {
          const loc = String(location ?? "");
          Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
          res.statusCode = code;
          res.setHeader("Location", loc);
          res.end();
        },
      };
      return chain;
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
  const url = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);
  const pathname = url.pathname;

  if (!pathname.startsWith("/api")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found", path: pathname }));
    return;
  }

  const hasBody = /^(POST|PUT|PATCH)$/i.test(req.method || "");
  if (hasBody) {
    const raw = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    try {
      req.body = raw && raw.trim() ? JSON.parse(raw) : {};
    } catch {
      req.body = {};
    }
  } else {
    req.body = {};
  }

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

server.on("error", (err) => {
  console.error("[BOOT] Falha ao abrir servidor HTTP — verifique se a porta está livre:", err?.message || err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[BOOT] listening http://localhost:${PORT}`);
  console.log(`[BOOT] teste rápido: GET http://localhost:${PORT}/api/health`);
  console.log(`[BOOT] OAuth diag:  GET http://localhost:${PORT}/api/ml/oauth-config`);
});
