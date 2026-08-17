// =============================================================================
// S7 — Dispatcher Central (Fase S5.2)
// Política de retry — ESTRUTURA preparada, dirigida por configuração (env).
//
// Não decide regra de negócio: apenas calcula tentativas/backoff a partir de
// configuração. Alinha-se ao backoff já praticado pelo outbox (attempts * base).
// =============================================================================

/** @param {string} key @param {number} fallback */
function envInt(key, fallback) {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * Defaults do retry (sobreponíveis por env, sem hardcode de negócio).
 * - MAX_ATTEMPTS: teto de tentativas por dispatch.
 * - BASE_BACKOFF_MS: base do backoff linear (compatível com outbox: attempt*base).
 * - MAX_BACKOFF_MS: teto do atraso entre tentativas.
 */
export const S7_DISPATCH_RETRY_DEFAULTS = Object.freeze({
  MAX_ATTEMPTS: 3,
  BASE_BACKOFF_MS: 60000,
  MAX_BACKOFF_MS: 3600000,
});

/**
 * Resolve a política de retry de um canal a partir de env, com fallback global.
 * Ex.: S7_DISPATCH_RETRY_WHATSAPP_MAX_ATTEMPTS, S7_DISPATCH_RETRY_BASE_BACKOFF_MS.
 *
 * @param {string} channel
 * @returns {{ maxAttempts: number; baseBackoffMs: number; maxBackoffMs: number }}
 */
export function resolveDispatchRetryPolicy(channel) {
  const ch = String(channel ?? "").trim().toUpperCase();

  const maxAttempts = envInt(
    `S7_DISPATCH_RETRY_${ch}_MAX_ATTEMPTS`,
    envInt("S7_DISPATCH_RETRY_MAX_ATTEMPTS", S7_DISPATCH_RETRY_DEFAULTS.MAX_ATTEMPTS)
  );
  const baseBackoffMs = envInt(
    `S7_DISPATCH_RETRY_${ch}_BASE_BACKOFF_MS`,
    envInt("S7_DISPATCH_RETRY_BASE_BACKOFF_MS", S7_DISPATCH_RETRY_DEFAULTS.BASE_BACKOFF_MS)
  );
  const maxBackoffMs = envInt(
    "S7_DISPATCH_RETRY_MAX_BACKOFF_MS",
    S7_DISPATCH_RETRY_DEFAULTS.MAX_BACKOFF_MS
  );

  return { maxAttempts, baseBackoffMs, maxBackoffMs };
}

/**
 * Decide se um dispatch pode tentar novamente e quando.
 * Função pura: o agendamento real (status RETRY_SCHEDULED + next_retry_at) é
 * responsabilidade do worker/caller — aqui só calculamos.
 *
 * @param {{ channel: string; attempt: number; now?: number }} input
 * @returns {{
 *   shouldRetry: boolean;
 *   nextAttempt: number;
 *   delayMs: number;
 *   nextRetryAt: string | null;
 *   maxAttempts: number;
 * }}
 */
export function planDispatchRetry(input) {
  const policy = resolveDispatchRetryPolicy(input.channel);
  const attempt = Math.max(0, Number(input.attempt) || 0);
  const nextAttempt = attempt + 1;

  if (nextAttempt > policy.maxAttempts) {
    return {
      shouldRetry: false,
      nextAttempt,
      delayMs: 0,
      nextRetryAt: null,
      maxAttempts: policy.maxAttempts,
    };
  }

  const delayMs = Math.min(policy.maxBackoffMs, nextAttempt * policy.baseBackoffMs);
  const base = Number.isFinite(input.now) ? Number(input.now) : Date.now();

  return {
    shouldRetry: true,
    nextAttempt,
    delayMs,
    nextRetryAt: new Date(base + delayMs).toISOString(),
    maxAttempts: policy.maxAttempts,
  };
}
