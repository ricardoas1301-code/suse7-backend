// ======================================================================
// Fingerprint de deploy / módulo OAuth ML — diagnóstico “qual código está no ar”.
// Atualize os *_REV ao tocar o fluxo correspondente (não depende de git em runtime).
// ======================================================================

/** Bump quando alterar `src/handlers/ml/callback.js` (fluxo OAuth redirect). */
export const ML_OAUTH_CALLBACK_MODULE_REV = "20260605-oauth-env-coherence-v2";

/** Bump quando alterar `src/handlers/ml/_helpers/mlOAuthConnectPersistence.js`. */
export const ML_OAUTH_PERSISTENCE_MODULE_REV = "20260211-oauth-persistence-v2";

/** Bump quando alterar `src/services/marketplace/marketplaceAccountConnectionHealth.js`. */
export const ML_MARKETPLACE_CONNECTION_HEALTH_REV = "20260211-connection-health-v2";

/** Bump quando alterar `src/handlers/ml/_helpers/mlToken.js`. */
export const ML_TOKEN_HELPER_REV = "20260211-ml-token-guard-v2";

/**
 * Log estruturado único para colar nos logs do Vercel/Supabase Edge e cruzar com GitHub.
 * @param {string} [scope] — ex.: "ml/callback", "api/ml/connect"
 */
export function logMlOAuthBuildFingerprint(scope = "ml/oauth") {
  console.info(`[${scope}] build_fingerprint`, {
    scope,
    ml_oauth_callback_module_rev: ML_OAUTH_CALLBACK_MODULE_REV,
    ml_oauth_persistence_module_rev: ML_OAUTH_PERSISTENCE_MODULE_REV,
    ml_marketplace_connection_health_rev: ML_MARKETPLACE_CONNECTION_HEALTH_REV,
    ml_token_helper_rev: ML_TOKEN_HELPER_REV,
    vercel_git_commit: process.env.VERCEL_GIT_COMMIT ?? null,
    vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    vercel_env: process.env.VERCEL_ENV ?? null,
    node_env: process.env.NODE_ENV ?? null,
  });
}
