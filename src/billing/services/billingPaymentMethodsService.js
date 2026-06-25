// ======================================================================
// Formas de pagamento salvas — tokenização via gateway (backend only)
// ======================================================================

import {
  cardTypeFromPaymentMethodRow,
  methodTypeFromCardType,
  normalizePersistedCardType,
  supportsAutoRenewFromPaymentMethodRow,
} from "../utils/billingCardType.js";

/**
 * @typedef {{
 *   id: string;
 *   provider: string;
 *   method_type: string;
 *   brand: string | null;
 *   last4: string | null;
 *   holder_name: string | null;
 *   expiration_month: string | null;
 *   expiration_year: string | null;
 *   expires_at: string | null;
 *   card_type: "CREDIT" | "DEBIT";
 *   supports_auto_renew: boolean;
 *   is_default: boolean;
 *   status: string;
 * }} BillingPaymentMethodRow
 */

function isMissingRelationError(error) {
  const msg = String(error?.message ?? "").toLowerCase();
  return (
    String(error?.code ?? "") === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table")
  );
}

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {string | null | undefined} month
 * @param {string | null | undefined} year
 */
function buildExpiresAt(month, year) {
  const mm = asTrimmedString(month);
  const yy = asTrimmedString(year);
  if (!mm || !yy) return null;
  const yearFull = yy.length === 2 ? `20${yy}` : yy;
  const monthNum = Number(mm);
  const yearNum = Number(yearFull);
  if (!Number.isFinite(monthNum) || !Number.isFinite(yearNum) || monthNum < 1 || monthNum > 12) return null;
  const lastDay = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();
  return new Date(Date.UTC(yearNum, monthNum - 1, lastDay, 23, 59, 59)).toISOString();
}

/**
 * @param {Record<string, unknown>} row
 * @returns {BillingPaymentMethodRow}
 */
function mapPaymentMethodRow(row) {
  const expirationMonth = asTrimmedString(row.expiration_month);
  const expirationYear = asTrimmedString(row.expiration_year);
  return {
    id: String(row.id),
    provider: asTrimmedString(row.provider) ?? asTrimmedString(row.gateway) ?? "unknown",
    method_type: asTrimmedString(row.method_type) ?? "unknown",
    brand: asTrimmedString(row.brand),
    last4: asTrimmedString(row.last4),
    holder_name: asTrimmedString(row.holder_name),
    expiration_month: expirationMonth,
    expiration_year: expirationYear,
    expires_at: asTrimmedString(row.expires_at) ?? buildExpiresAt(expirationMonth, expirationYear),
    card_type: cardTypeFromPaymentMethodRow(row),
    supports_auto_renew: supportsAutoRenewFromPaymentMethodRow(row),
    is_default: Boolean(row.is_default),
    status: asTrimmedString(row.status) ?? "unknown",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<BillingPaymentMethodRow[]>}
 */
export async function listSellerPaymentMethods(supabase, userId) {
  const { data, error } = await supabase
    .from("billing_payment_methods")
    .select(
      "id, provider, gateway, method_type, card_type, supports_auto_renew, brand, last4, holder_name, expiration_month, expiration_year, expires_at, is_default, status"
    )
    .eq("user_id", userId)
    .neq("status", "INACTIVE")
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }

  return (Array.isArray(data) ? data : []).map((row) => mapPaymentMethodRow(/** @type {Record<string, unknown>} */ (row)));
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} methodId
 */
export async function getSellerPaymentMethodById(supabase, userId, methodId) {
  const { data, error } = await supabase
    .from("billing_payment_methods")
    .select(
      "id, user_id, provider, gateway, gateway_payment_method_id, asaas_customer_id, method_type, card_type, supports_auto_renew, brand, last4, holder_name, expiration_month, expiration_year, expires_at, is_default, status"
    )
    .eq("user_id", userId)
    .eq("id", methodId)
    .neq("status", "INACTIVE")
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function clearDefaultPaymentMethods(supabase, userId) {
  const { error } = await supabase
    .from("billing_payment_methods")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("is_default", true);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   asaasCustomerId: string;
 *   gatewayPaymentMethodId: string;
 *   brand: string | null;
 *   last4: string | null;
 *   holderName: string | null;
 *   expirationMonth: string | null;
 *   expirationYear: string | null;
 *   cardType?: "CREDIT" | "DEBIT" | string;
 *   setDefault?: boolean;
 *   rawPayload?: Record<string, unknown>;
 * }} input
 */
export async function insertSellerCardPaymentMethod(supabase, input) {
  const cardType = normalizePersistedCardType(input.cardType);
  const supportsAutoRenew = cardType === "CREDIT";

  if (input.setDefault) {
    await clearDefaultPaymentMethods(supabase, input.userId);
  }

  const expiresAt = buildExpiresAt(input.expirationMonth, input.expirationYear);
  const row = {
    user_id: input.userId,
    asaas_customer_id: input.asaasCustomerId,
    gateway: "asaas",
    provider: "asaas",
    gateway_payment_method_id: input.gatewayPaymentMethodId,
    method_type: methodTypeFromCardType(cardType),
    card_type: cardType,
    supports_auto_renew: supportsAutoRenew,
    brand: input.brand,
    last4: input.last4,
    holder_name: input.holderName,
    expiration_month: input.expirationMonth,
    expiration_year: input.expirationYear,
    expires_at: expiresAt,
    status: "ACTIVE",
    is_default: Boolean(input.setDefault),
    raw_payload: input.rawPayload ?? {},
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("billing_payment_methods").insert(row).select("*").single();
  if (error) throw error;
  return mapPaymentMethodRow(/** @type {Record<string, unknown>} */ (data));
}

/** @deprecated Use insertSellerCardPaymentMethod */
export async function insertSellerCreditCardPaymentMethod(supabase, input) {
  return insertSellerCardPaymentMethod(supabase, { ...input, cardType: "CREDIT" });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} methodId
 */
export async function deactivateSellerPaymentMethod(supabase, userId, methodId) {
  const existing = await getSellerPaymentMethodById(supabase, userId, methodId);
  if (!existing) {
    const err = new Error("PAYMENT_METHOD_NOT_FOUND");
    /** @type {any} */ (err).code = "PAYMENT_METHOD_NOT_FOUND";
    throw err;
  }

  const { error } = await supabase
    .from("billing_payment_methods")
    .update({ status: "INACTIVE", is_default: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", methodId);

  if (error) throw error;
  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} methodId
 */
export async function setDefaultSellerPaymentMethod(supabase, userId, methodId) {
  const existing = await getSellerPaymentMethodById(supabase, userId, methodId);
  if (!existing) {
    const err = new Error("PAYMENT_METHOD_NOT_FOUND");
    /** @type {any} */ (err).code = "PAYMENT_METHOD_NOT_FOUND";
    throw err;
  }

  await clearDefaultPaymentMethods(supabase, userId);
  const { error } = await supabase
    .from("billing_payment_methods")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", methodId);

  if (error) throw error;
  const methods = await listSellerPaymentMethods(supabase, userId);
  return methods.find((m) => m.id === methodId) ?? null;
}
