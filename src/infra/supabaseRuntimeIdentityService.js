/**
 * Identidade runtime Supabase — expected (config) vs actual (SUPABASE_URL).
 *
 * Contrato fail-closed:
 * - expected ausente → inválido para gates que exigem identidade explícita
 * - actual não extraível → inválido
 * - expected !== actual → inválido
 * - PROD conhecido nunca tratado como DEV
 */

export const S7_KNOWN_SUPABASE_PROJECT_REF = Object.freeze({
  PROD: "bazibzquasbdgjwdcwbz",
});

/** @deprecated Preferir identidade via S7_EXPECTED_SUPABASE_PROJECT_REF. Mantido para guards legados conhecidos. */
export const S7_LEGACY_SUPABASE_PROJECT_REF = Object.freeze({
  DEV_V1: "ujznkyvgqhxagemdgmor",
});

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function extractSupabaseProjectRef(env = process.env) {
  const url = String(env.SUPABASE_URL || "").trim();
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url);
  return m?.[1]?.toLowerCase() || null;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function readExpectedSupabaseProjectRef(env = process.env) {
  const ref = String(env.S7_EXPECTED_SUPABASE_PROJECT_REF || "")
    .trim()
    .toLowerCase();
  return ref || null;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function resolveSupabaseRuntimeIdentity(env = process.env) {
  /** @type {string[]} */
  const reasons = [];
  const actualRef = extractSupabaseProjectRef(env);
  const expectedRef = readExpectedSupabaseProjectRef(env);

  if (!expectedRef) reasons.push("SUPABASE_EXPECTED_PROJECT_REF_ABSENT");
  if (!actualRef) reasons.push("SUPABASE_ACTUAL_PROJECT_REF_ABSENT");
  if (expectedRef && actualRef && expectedRef !== actualRef) {
    reasons.push("SUPABASE_PROJECT_REF_MISMATCH_EXPECTED");
  }

  const isProdTarget =
    actualRef === S7_KNOWN_SUPABASE_PROJECT_REF.PROD ||
    expectedRef === S7_KNOWN_SUPABASE_PROJECT_REF.PROD;

  const ok =
    reasons.length === 0 && Boolean(expectedRef) && Boolean(actualRef);

  return {
    ok,
    expectedRef,
    actualRef,
    matched: ok,
    isProdTarget,
    isKnownProdActual: actualRef === S7_KNOWN_SUPABASE_PROJECT_REF.PROD,
    reasons,
  };
}

/**
 * Ambiente DEV/staging com identidade explícita coerente e sem alvo PROD.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function isDevSupabaseRuntimeIdentityCoherent(env = process.env) {
  const identity = resolveSupabaseRuntimeIdentity(env);
  return identity.ok && !identity.isProdTarget;
}
