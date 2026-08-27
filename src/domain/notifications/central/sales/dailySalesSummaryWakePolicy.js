/**
 * CPJ2 T16 — politica de wake Daily Sales (owner unico / anti-dual).
 *
 * Primario futuro (Hosted cutover): Vercel Cron → /api/jobs/daily-sales-summary-automation
 * Primario atual (remoto): GitHub Actions (X-Job-Secret)
 *
 * Gate: DAILY_SALES_VERCEL_WAKE_ENABLED=1 habilita execucao originada de Vercel Cron.
 * Sem o flag (ausente/invalido/0): invocacoes Vercel autenticadas respondem 200 skipped
 * (nao falham o cron; evitam dual-primary acidental apos deploy do vercel.json).
 *
 * A flag NAO desliga Daily Sales: GH / X-Job-Secret continua autorizado.
 */

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isDailySalesVercelWakeEnabled(env = process.env) {
  const raw = String(env.DAILY_SALES_VERCEL_WAKE_ENABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {{ authMode?: string | null }} [auth]
 * @returns {"vercel_cron" | "job_secret" | "cron_secret" | "none" | "unknown"}
 */
export function resolveDailySalesWakeSource(req, auth = {}) {
  const vercelCronHeader =
    req?.headers?.["x-vercel-cron"] != null && String(req.headers["x-vercel-cron"]).trim() !== "";
  if (vercelCronHeader) return "vercel_cron";

  const mode = auth.authMode != null ? String(auth.authMode) : "";
  if (mode === "x-job-secret") return "job_secret";
  if (mode === "cron-secret") return "cron_secret";
  if (mode === "none") return "none";
  return "unknown";
}

/**
 * Decide se o tick deve executar o motor ou ser skipped (anti-dual).
 *
 * @param {{
 *   wakeSource: string;
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
 * }} args
 * @returns {{ execute: boolean; skip_reason: string | null; vercel_wake_enabled: boolean }}
 */
export function evaluateDailySalesWakeExecution(args) {
  const env = args.env ?? process.env;
  const enabled = isDailySalesVercelWakeEnabled(env);
  const source = String(args.wakeSource || "unknown");

  // Vercel Cron so processa com flag explicito (cutover controlado).
  if (source === "vercel_cron") {
    if (!enabled) {
      return {
        execute: false,
        skip_reason: "vercel_wake_disabled",
        vercel_wake_enabled: false,
      };
    }
    return { execute: true, skip_reason: null, vercel_wake_enabled: true };
  }

  // Bearer CRON_SECRET sem header x-vercel-cron: potencial Vercel/legado — mesmo anti-dual.
  if (source === "cron_secret") {
    if (!enabled) {
      return {
        execute: false,
        skip_reason: "vercel_wake_disabled",
        vercel_wake_enabled: false,
      };
    }
    return { execute: true, skip_reason: null, vercel_wake_enabled: true };
  }

  // job_secret = GH Actions / homologacao manual — permitido enquanto GH for primario.
  // none/unknown: nao bloquear por esta flag (auth ja decidiu allow).
  return { execute: true, skip_reason: null, vercel_wake_enabled: enabled };
}
