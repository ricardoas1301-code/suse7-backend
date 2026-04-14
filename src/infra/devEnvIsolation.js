// ======================================================
// Isolamento DEV (npm run dev) — frontend local
// Reescreve FRONTEND_URL se for domínio público Suse7 (evita redirects OAuth para app em produção).
// ML_REDIRECT_URI NÃO é alterado aqui: deve ser idêntico ao cadastrado no app Mercado Livre
// (ex.: URL HTTPS do deploy suse7-backend-dev na Vercel). O npm run dev só inicia o OAuth;
// o callback pode ser atendido pelo backend deployado.
// SUSE7_ALLOW_PROD_ENV_IN_DEV=1 desativa também o ajuste de FRONTEND_URL.
// ======================================================

/**
 * @param {string | undefined} url
 */
function isObviousProductionSuse7Frontend(url) {
  const s = String(url || "").trim().toLowerCase();
  if (!s) return false;
  if (s.includes("localhost") || s.includes("127.0.0.1")) return false;
  return (
    s.includes("app.suse7.com.br") ||
    s.includes("www.suse7.com.br") ||
    /^https?:\/\/suse7\.com\.br(\/|$)/i.test(s.trim())
  );
}

/**
 * @param {number} port porta do dev-server (ex.: 3001)
 * @returns {{ overridden: string[] }}
 */
export function applyDevServerEnvIsolation(port) {
  const overridden = [];

  if (process.env.SUSE7_ALLOW_PROD_ENV_IN_DEV === "1") {
    console.info("[BOOT] SUSE7_ALLOW_PROD_ENV_IN_DEV=1 — isolamento DEV desativado (URLs do .env preservadas)");
    return { overridden };
  }

  const localFrontend = "http://localhost:5173";

  const fe = (process.env.FRONTEND_URL || "").trim();
  if (!fe) {
    process.env.FRONTEND_URL = localFrontend;
    overridden.push("FRONTEND_URL");
    console.info(`[BOOT] FRONTEND_URL vazio — usando ${localFrontend}`);
  } else if (isObviousProductionSuse7Frontend(fe)) {
    const was = fe.length > 56 ? `${fe.slice(0, 56)}…` : fe;
    console.warn(`[BOOT] DEV isolation: FRONTEND_URL era público Suse7 (${was}); usando ${localFrontend}`);
    process.env.FRONTEND_URL = localFrontend;
    overridden.push("FRONTEND_URL");
  }

  return { overridden };
}

/**
 * @deprecated Não reescrever ML_REDIRECT_URI no dev-server; mantido para testes que importam utilitário legado.
 * @param {string} redirectUri
 * @param {string} portStr
 */
export function isLocalMlCallbackForPort(redirectUri, portStr) {
  try {
    const u = new URL(String(redirectUri || "").trim());
    const h = u.hostname.toLowerCase();
    if (h !== "localhost" && h !== "127.0.0.1") return false;
    const path = (u.pathname || "").replace(/\/+$/, "") || "/";
    if (path !== "/api/ml/callback") return false;
    const effectivePort =
      u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return effectivePort === String(portStr);
  } catch {
    return false;
  }
}
