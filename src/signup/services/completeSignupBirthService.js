// =============================================================================
// Completion pós-confirmação — RPC atômica (profile + legal + company + recipients)
// =============================================================================

import { rpcCompleteSignupBirthOnce } from "./signupPendingBirthRepository.js";

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} authUserId
 */
export async function completeSignupBirthOnce(supabase, authUserId) {
  const { data, error } = await rpcCompleteSignupBirthOnce(supabase, authUserId);

  if (error) {
    const code = String(error.code ?? "");
    if (code === "PGRST202") {
      return {
        ok: false,
        code: "RPC_NOT_AVAILABLE",
        message: "Conclusão atômica de cadastro indisponível neste ambiente.",
        details: error,
      };
    }
    return {
      ok: false,
      code: "RPC_ERROR",
      message: error.message ?? "Falha ao concluir cadastro.",
      details: error,
    };
  }

  const payload = data && typeof data === "object" ? data : {};
  if (payload.ok !== true) {
    return {
      ok: false,
      code: payload.code ?? "COMPLETION_FAILED",
      message: payload.message ?? "Não foi possível concluir o cadastro.",
      details: payload,
    };
  }

  return {
    ok: true,
    code: payload.code ?? "COMPLETED",
    idempotent: payload.idempotent === true,
    pending_id: payload.pending_id ?? null,
    company_created: payload.company_created === true,
    recipient_bootstrap: payload.recipient_bootstrap ?? null,
    recipient_product_note: "NOTIFICATIONS.DEFAULT-FULL-RECIPIENT.01 — current impl may create 2 channel rows",
  };
}
