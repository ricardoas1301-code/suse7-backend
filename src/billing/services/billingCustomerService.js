// ======================================================================
// billingCustomerService — cliente de cobrança por usuário + provider
// ======================================================================

import { logBilling } from "../billingLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} provider
 * @param {string} userId
 */
export async function getBillingCustomerByUser(supabase, provider, userId) {
  const { data, error } = await supabase
    .from("billing_customers")
    .select("id, user_id, provider, provider_customer_id, email, created_at")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} providerKey
 * @param {{ id: string; email?: string | null; user_metadata?: Record<string, unknown> }} user
 */
export async function ensureBillingCustomerForUser(supabase, providerApi, providerKey, user) {
  const existing = await getBillingCustomerByUser(supabase, providerKey, user.id);
  if (existing?.provider_customer_id) {
    return existing;
  }

  const emailRaw = user.email != null && String(user.email).trim() !== "" ? String(user.email).trim() : "";
  const metaName = user.user_metadata?.full_name ?? user.user_metadata?.name;
  const name =
    typeof metaName === "string" && metaName.trim() !== ""
      ? metaName.trim()
      : emailRaw || `Suse7 user ${user.id}`;

  const email =
    emailRaw ||
    `billing+${user.id.replace(/-/g, "")}@users.suse7.internal`;

  logBilling("billing", "create_remote_customer", { provider: providerKey, user_id: user.id });

  const created = await providerApi.createCustomer({
    name,
    email,
    externalReference: user.id,
  });

  const providerCustomerId =
    created && typeof created === "object" && typeof /** @type {{ id?: unknown }} */ (created).id === "string"
      ? String(/** @type {{ id?: string }} */ (created).id)
      : null;
  if (!providerCustomerId) {
    throw new Error("Resposta do gateway sem id de cliente");
  }

  const row = {
    user_id: user.id,
    provider: providerKey,
    provider_customer_id: providerCustomerId,
    email: emailRaw || email,
  };

  const { data, error } = await supabase.from("billing_customers").insert(row).select("*").single();
  if (error?.code === "23505") {
    const again = await getBillingCustomerByUser(supabase, providerKey, user.id);
    if (again) return again;
  }
  if (error) throw error;
  return data;
}
