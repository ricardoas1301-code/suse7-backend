// =============================================================================
// Repositório — signup pending birth via RPC service_role
// =============================================================================

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Record<string, unknown>} args
 */
export async function rpcCreatePendingBirth(supabase, args) {
  return supabase.rpc("s7_signup_pending_birth_create", args);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} tokenHash
 * @param {string} authUserId
 * @param {string} authEmail
 */
export async function rpcBindPendingBirth(supabase, tokenHash, authUserId, authEmail) {
  return supabase.rpc("s7_signup_pending_birth_bind", {
    p_correlation_token_hash: tokenHash,
    p_auth_user_id: authUserId,
    p_auth_email: authEmail,
  });
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} tokenHash
 * @param {string} [reason]
 */
export async function rpcAbortPendingBirth(supabase, tokenHash, reason = "SIGNUP_FAILED") {
  return supabase.rpc("s7_signup_pending_birth_abort", {
    p_correlation_token_hash: tokenHash,
    p_reason: reason,
  });
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} authUserId
 */
export async function rpcCompleteSignupBirthOnce(supabase, authUserId) {
  return supabase.rpc("s7_complete_signup_birth_once", { p_auth_user_id: authUserId });
}
