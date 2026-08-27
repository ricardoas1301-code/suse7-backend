/**
 * CPJ2 T16 — política de wake marketplace sync (owner único / anti-dual).
 *
 * Primário futuro (Hosted/PROD cutover): Vercel Cron → GET/POST /api/jobs/marketplace-account-sync
 * Primário atual (remoto): GitHub Actions (suse7-scheduler DEV / backend PROD)
 * Nudges: start-initial-sync / OAuth callback (X-Job-Secret)
 *
 * Gate: MARKETPLACE_SYNC_VERCEL_WAKE_ENABLED=1 habilita execução originada de Vercel Cron.
 * Sem o flag, invocações Vercel Cron autenticadas respondem 200 skipped (não falham o cron;
 * evitam dual-primary acidental se vercel.json for deployado antes do cutover).
 */

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isMarketplaceSyncVercelWakeEnabled(env = process.env) {
  const raw = String(env.MARKETPLACE_SYNC_VERCEL_WAKE_ENABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {{ authMode?: string | null }} [auth]
 * @returns {"vercel_cron" | "job_secret" | "cron_secret" | "none" | "unknown"}
 */
export function resolveMarketplaceSyncWakeSource(req, auth = {}) {
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
 * Decide se o tick deve executar o drain ou ser skipped (anti-dual).
 *
 * @param {{
 *   wakeSource: string;
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
 * }} args
 * @returns {{ execute: boolean; skip_reason: string | null; vercel_wake_enabled: boolean }}
 */
export function evaluateMarketplaceSyncWakeExecution(args) {
  const env = args.env ?? process.env;
  const enabled = isMarketplaceSyncVercelWakeEnabled(env);
  const source = String(args.wakeSource || "unknown");

  // Vercel Cron só processa com flag explícito (cutover controlado).
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

  // Bearer CRON_SECRET sem header x-vercel-cron: tratado como potencial Vercel/legado.
  // Só executa se flag ON (mesmo anti-dual); caso contrário skip seguro.
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

  // job_secret = GH Actions / nudges / harness manual — permitido enquanto GH for primário.
  return { execute: true, skip_reason: null, vercel_wake_enabled: enabled };
}

/**
 * Default de limit para ticks de wake (fairness).
 * @param {{ wakeSource: string; requestedLimit?: number | null }} args
 * @returns {number | null}
 */
export function resolveMarketplaceSyncWakeDefaultLimit(args) {
  if (args.requestedLimit != null && Number.isFinite(Number(args.requestedLimit))) {
    return Math.max(1, Math.min(50, Number(args.requestedLimit)));
  }
  if (args.wakeSource === "vercel_cron" || args.wakeSource === "cron_secret") {
    return 1;
  }
  return null;
}
