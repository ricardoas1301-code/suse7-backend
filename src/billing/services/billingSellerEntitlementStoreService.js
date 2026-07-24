// ======================================================================
// Persistência overlay de entitlement/trial — sem assinatura paga fictícia
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_ENTITLEMENT_OVERLAY_PROVIDER,
  BILLING_ENTITLEMENT_OVERLAY_STATUS,
} from "../billingConstants.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function loadSellerEntitlementOverlay(supabase, userId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, metadata, updated_at")
    .eq("user_id", userId)
    .eq("provider", BILLING_ENTITLEMENT_OVERLAY_PROVIDER)
    .eq("status", BILLING_ENTITLEMENT_OVERLAY_STATUS)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return {
    overlay_id: data?.id != null ? String(data.id) : null,
    metadata: asObject(data?.metadata),
    updated_at: data?.updated_at ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function ensureSellerEntitlementOverlay(supabase, userId) {
  const existing = await loadSellerEntitlementOverlay(supabase, userId);
  if (existing.overlay_id) return existing;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .insert({
      user_id: userId,
      plan_id: null,
      plan_key: null,
      provider: BILLING_ENTITLEMENT_OVERLAY_PROVIDER,
      provider_customer_id: "internal",
      provider_subscription_id: null,
      status: BILLING_ENTITLEMENT_OVERLAY_STATUS,
      amount: "0.00",
      currency: "BRL",
      metadata: { overlay: true, source: "entitlement_store" },
      created_at: now,
      updated_at: now,
    })
    .select("id, metadata, updated_at")
    .single();
  if (error) throw error;
  logBilling("billing", "BILLING_ENTITLEMENT_OVERLAY_CREATED", { user_id: userId, overlay_id: data.id });
  return {
    overlay_id: String(data.id),
    metadata: asObject(data.metadata),
    updated_at: data.updated_at ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} overlayId
 * @param {Record<string, unknown>} currentMeta
 * @param {Record<string, unknown>} patch
 * @param {{ idempotency_key?: string | null; source?: string | null }} [options]
 */
export async function patchSellerEntitlementOverlayMetadata(
  supabase,
  overlayId,
  currentMeta,
  patch,
  options = {}
) {
  const nextMeta = { ...currentMeta, ...patch };
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
    .eq("id", overlayId)
    .select("metadata, updated_at")
    .single();
  if (error) throw error;
  logBilling("billing", "BILLING_ENTITLEMENT_OVERLAY_PATCHED", {
    overlay_id: overlayId,
    source: options.source ?? null,
    idempotency_key: options.idempotency_key ?? null,
    keys: Object.keys(patch),
  });
  return { metadata: asObject(data.metadata), updated_at: data.updated_at ?? null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {Record<string, unknown>} currentMeta
 * @param {Record<string, unknown>} patch
 * @param {{ idempotency_key?: string | null; source?: string | null }} [options]
 */
export async function patchSubscriptionEntitlementMetadata(
  supabase,
  subscriptionId,
  currentMeta,
  patch,
  options = {}
) {
  const nextMeta = { ...currentMeta, ...patch };
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
    .eq("id", subscriptionId);
  if (error) throw error;
  logBilling("billing", "BILLING_SUBSCRIPTION_ENTITLEMENT_PATCHED", {
    subscription_id: subscriptionId,
    source: options.source ?? null,
    idempotency_key: options.idempotency_key ?? null,
    keys: Object.keys(patch),
  });
  return nextMeta;
}
