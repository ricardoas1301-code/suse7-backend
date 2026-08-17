// ======================================================================
// Derivação server-side do contexto OAuth ML — frontend NÃO é authority.
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";

/** @typedef {"first_account" | "additional_account"} MlOAuthFlowType */

/**
 * Conta ativa = status IS DISTINCT FROM 'removed' (NULL conta como vínculo ativo).
 * @param {string | null | undefined} status
 */
export function marketplaceAccountStatusAtivo(status) {
  const s = status != null ? String(status).trim().toLowerCase() : "";
  return s !== "removed";
}

/**
 * Deriva flow_type e flags de onboarding a partir do estado real do tenant.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function resolverContextoFluxoMlOAuth(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return {
      ok: false,
      code: "invalid_user",
      flow_type: /** @type {MlOAuthFlowType} */ ("first_account"),
      onboarding_first_connection: false,
      active_ml_account_count: 0,
      initial_configuration_completed: false,
      first_marketplace_connected: false,
    };
  }

  const [profileRes, accountsRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, initial_configuration_completed_at, first_marketplace_connected_at")
      .eq("id", uid)
      .maybeSingle(),
    supabase
      .from("marketplace_accounts")
      .select("id, status")
      .eq("user_id", uid)
      .eq("marketplace", ML_MARKETPLACE_SLUG),
  ]);

  const profile = profileRes.data ?? null;
  const rows = Array.isArray(accountsRes.data) ? accountsRes.data : [];
  const activeRows = rows.filter((r) => marketplaceAccountStatusAtivo(r?.status));
  const activeCount = activeRows.length;

  const initialConfigCompleted =
    profile?.initial_configuration_completed_at != null &&
    String(profile.initial_configuration_completed_at).trim() !== "";
  const firstMarketplaceConnected =
    profile?.first_marketplace_connected_at != null &&
    String(profile.first_marketplace_connected_at).trim() !== "";

  /** @type {MlOAuthFlowType} */
  const flowType = activeCount >= 1 ? "additional_account" : "first_account";
  const onboardingFirstConnection = !initialConfigCompleted && !firstMarketplaceConnected && flowType === "first_account";

  return {
    ok: true,
    flow_type: flowType,
    onboarding_first_connection: onboardingFirstConnection,
    active_ml_account_count: activeCount,
    initial_configuration_completed: initialConfigCompleted,
    first_marketplace_connected: firstMarketplaceConnected,
  };
}

/**
 * Callback: redirect onboarding vs integrações — somente contexto do state server-side.
 * @param {{ flow_type?: string | null; onboarding_first_connection?: boolean | null }} oauthCtx
 * @param {boolean} [profileInitialConfigCompleted]
 */
export function resolverRedirectOnboardingPosOAuth(oauthCtx, profileInitialConfigCompleted = false) {
  if (profileInitialConfigCompleted) return false;
  if (oauthCtx?.onboarding_first_connection === true) return true;
  const ft = oauthCtx?.flow_type != null ? String(oauthCtx.flow_type).trim() : "";
  return ft === "first_account" || ft === "onboarding_first_connection";
}
