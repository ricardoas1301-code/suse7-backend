// ======================================================================
// billingCustomerService — cliente de cobrança por usuário + provider
// S1.HF.ASAAS-NOTIFICATIONS.1 — política de notificação fail-closed
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  assertCustomerNotificationPolicyForCharge,
  ensureAsaasCustomerNotificationPolicy,
  ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED,
} from "./billingAsaasCustomerNotificationPolicyService.js";

/**
 * @param {unknown} value
 */
function normalizeTaxIdDigits(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 || digits.length === 14) return digits;
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
function taxIdFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const candidates = [metadata.cpf_cnpj, metadata.document, metadata.cnpj, metadata.cpf];
  for (const candidate of candidates) {
    const digits = normalizeTaxIdDigits(candidate);
    if (digits) return digits;
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ id: string; user_metadata?: Record<string, unknown> }} user
 */
async function resolveCheckoutTaxId(supabase, user) {
  const fromMetadata = taxIdFromMetadata(user.user_metadata);
  if (fromMetadata) return fromMetadata;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("cpf_cnpj")
    .eq("id", user.id)
    .maybeSingle();
  if (!profileError) {
    const fromProfile = normalizeTaxIdDigits(profile?.cpf_cnpj);
    if (fromProfile) return fromProfile;
  }

  const { data: companies, error: companiesError } = await supabase
    .from("seller_companies")
    .select("document_cnpj, is_primary")
    .eq("user_id", user.id)
    .order("is_primary", { ascending: false })
    .limit(5);
  if (!companiesError && Array.isArray(companies)) {
    for (const company of companies) {
      const fromCompany = normalizeTaxIdDigits(company?.document_cnpj);
      if (fromCompany) return fromCompany;
    }
  }

  return null;
}

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
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} providerCustomerId
 * @param {{ userId?: string | null; taxId?: string | null }} [opts]
 */
async function ensureAsaasNotificationsDisabled(providerApi, providerCustomerId, opts = {}) {
  const result = await ensureAsaasCustomerNotificationPolicy(providerApi, {
    providerCustomerId,
    userId: opts.userId ?? null,
    taxId: opts.taxId ?? null,
  });
  if (!result.ok) {
    const err = new Error("Operação temporariamente indisponível. Tente novamente em instantes.");
    /** @type {any} */ (err).code = ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED;
    /** @type {any} */ (err).httpStatus = 503;
    /** @type {any} */ (err).policyStatus = result.status;
    /** @type {any} */ (err).doesNotAffect = {
      delinquency: false,
      entitlement: false,
      babyFallback: false,
      grace: false,
      periodAdvance: false,
    };
    throw err;
  }
  return result;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} providerKey
 * @param {{ id: string; email?: string | null; user_metadata?: Record<string, unknown> }} user
 */
export async function ensureBillingCustomerForUser(supabase, providerApi, providerKey, user) {
  const taxId = await resolveCheckoutTaxId(supabase, user);
  if (!taxId) {
    const err = new Error("CPF ou CNPJ é obrigatório para checkout pago.");
    /** @type {any} */ (err).code = "CHECKOUT_TAX_ID_REQUIRED";
    throw err;
  }

  const existing = await getBillingCustomerByUser(supabase, providerKey, user.id);
  if (existing?.provider_customer_id) {
    if (providerKey === "asaas") {
      await ensureAsaasNotificationsDisabled(providerApi, existing.provider_customer_id, {
        userId: user.id,
        taxId,
      });
    }
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

  // Adapter Asaas aplica a política por último (ignora false do caller).
  const created = await providerApi.createCustomer({
    name,
    email,
    externalReference: user.id,
    cpfCnpj: taxId,
    notificationDisabled: true,
  });

  const providerCustomerId =
    created && typeof created === "object" && typeof /** @type {{ id?: unknown }} */ (created).id === "string"
      ? String(/** @type {{ id?: string }} */ (created).id)
      : null;
  if (!providerCustomerId) {
    throw new Error("Resposta do gateway sem id de cliente");
  }

  if (providerKey === "asaas") {
    // Confirmação remota pós-criação (idempotente; usa cache após sucesso)
    await ensureAsaasNotificationsDisabled(providerApi, providerCustomerId, {
      userId: user.id,
      taxId,
    });
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
    if (again) {
      if (providerKey === "asaas" && again.provider_customer_id) {
        await ensureAsaasNotificationsDisabled(providerApi, again.provider_customer_id, {
          userId: user.id,
          taxId,
        });
      }
      return again;
    }
  }
  if (error) throw error;
  return data;
}

/**
 * Gate explícito antes de createPayment/createSubscription (defesa em profundidade).
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {{ providerCustomerId: string; userId?: string | null }} input
 */
export async function assertBillingCustomerReadyForCharge(providerApi, input) {
  return assertCustomerNotificationPolicyForCharge(providerApi, {
    providerCustomerId: input.providerCustomerId,
    userId: input.userId ?? null,
  });
}
