// ======================================================================
// Histórico de cobranças — seller-centric (backend only)
// ======================================================================

import { isBillingPaymentPayable, normalizeBillingPaymentStatusKey } from "../utils/billingPaymentPayability.js";
import { mapPublicBoletoFieldsFromStoredPayload } from "./billingBoletoPaymentPresentation.js";
import { resolvePaymentHistoryAction } from "./billingPaymentHistoryActions.js";

/**
 * @typedef {{
 *   id: string;
 *   provider: string;
 *   provider_payment_id: string;
 *   subscription_id: string | null;
 *   plan_name: string | null;
 *   amount_cents: number | null;
 *   currency: string;
 *   billing_reason: string | null;
 *   status: string;
 *   due_date: string | null;
 *   paid_at: string | null;
 *   created_at: string;
 *   invoice_url: string | null;
 *   payment_method_type: string | null;
 *   action_type: string;
 *   action_label: string | null;
 *   renewal_cycle_id: string | null;
 * }} BillingPaymentHistoryRow
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
 * @param {unknown} amount
 */
function amountToCents(amount) {
  if (amount == null || amount === "") return null;
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * @param {unknown} status
 */
function normalizePaymentStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw) return "pending";
  if (["received", "confirmed", "received_in_cash", "paid", "pago"].includes(raw)) return "paid";
  if (["pending", "pendente", "awaiting_payment"].includes(raw)) return "pending";
  if (["overdue", "vencido", "past_due"].includes(raw)) return "overdue";
  if (["refunded", "estornado", "refund"].includes(raw)) return "refunded";
  if (["canceled", "cancelled", "deleted", "cancelado"].includes(raw)) return "canceled";
  if (["failed", "falhou", "chargeback", "chargeback_requested"].includes(raw)) return "failed";
  return raw;
}

/**
 * @param {unknown} rawPayload
 */
/**
 * @param {unknown} rawPayload
 */
function readPayloadForHistory(rawPayload) {
  return rawPayload && typeof rawPayload === "object" ? /** @type {Record<string, unknown>} */ (rawPayload) : {};
}

function extractPaymentPayloadFields(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" ? /** @type {Record<string, unknown>} */ (rawPayload) : {};
  const dueDate = asTrimmedString(payload.dueDate) ?? asTrimmedString(payload.originalDueDate);
  const invoiceUrl =
    asTrimmedString(payload.invoiceUrl) ??
    asTrimmedString(payload.bankSlipUrl) ??
    asTrimmedString(payload.transactionReceiptUrl);
  const paymentMethodType = asTrimmedString(payload.billingType) ?? asTrimmedString(payload.paymentMethod);
  const billingReason = asTrimmedString(payload.description) ?? asTrimmedString(payload.event_type_snapshot);
  return {
    due_date: dueDate,
    invoice_url: invoiceUrl,
    payment_method_type: paymentMethodType,
    billing_reason: billingReason,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Map<string, string>} planNameBySubscriptionId
 * @returns {BillingPaymentHistoryRow}
 */
function mapPaymentHistoryRow(row, planNameBySubscriptionId, renewalByPaymentId) {
  const payloadFields = extractPaymentPayloadFields(row.raw_payload);
  const subscriptionId = row.subscription_id != null ? String(row.subscription_id) : null;
  const planName = subscriptionId ? planNameBySubscriptionId.get(subscriptionId) ?? null : null;
  const payload = readPayloadForHistory(row.raw_payload);
  const paymentId = String(row.id);
  const renewal =
    renewalByPaymentId.get(paymentId) ??
    (payload.renewal_cycle_id
      ? { renewal_cycle_id: String(payload.renewal_cycle_id), renewal_status: null }
      : null);

  const status = normalizePaymentStatus(row.status);
  const payable = isBillingPaymentPayable(status);
  const invoiceUrl = payable ? payloadFields.invoice_url : null;
  const boletoFields = payable ? mapPublicBoletoFieldsFromStoredPayload(row.raw_payload) : null;
  const identificationField = boletoFields?.identification_field ?? null;
  const action = resolvePaymentHistoryAction(status, payloadFields.payment_method_type, payload, {
    renewal_cycle_id: renewal?.renewal_cycle_id ?? null,
    renewal_status: renewal?.renewal_status ?? null,
  });

  return {
    id: String(row.id),
    provider: asTrimmedString(row.provider) ?? "unknown",
    provider_payment_id: asTrimmedString(row.provider_payment_id) ?? String(row.id),
    subscription_id: subscriptionId,
    plan_name: planName,
    amount_cents: amountToCents(row.amount),
    currency: asTrimmedString(row.currency) ?? "BRL",
    billing_reason: payloadFields.billing_reason ?? asTrimmedString(row.event_type_snapshot),
    status,
    due_date: payloadFields.due_date,
    paid_at: asTrimmedString(row.paid_at),
    created_at: asTrimmedString(row.created_at) ?? new Date().toISOString(),
    invoice_url: invoiceUrl,
    identification_field: identificationField,
    payment_method_type: payloadFields.payment_method_type,
    action_type: action.action_type,
    action_label: action.action_label,
    renewal_cycle_id: renewal?.renewal_cycle_id ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<BillingPaymentHistoryRow[]>}
 */
export async function listSellerPaymentHistory(supabase, userId) {
  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, provider, provider_payment_id, subscription_id, status, amount, currency, paid_at, created_at, event_type_snapshot, raw_payload")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  const subscriptionIds = [...new Set(rows.map((row) => row.subscription_id).filter(Boolean))];
  const planNameBySubscriptionId = new Map();

  if (subscriptionIds.length > 0) {
    const { data: subscriptions, error: subscriptionsError } = await supabase
      .from("billing_subscriptions")
      .select("id, plan_key")
      .eq("user_id", userId)
      .in("id", subscriptionIds);

    if (!subscriptionsError && Array.isArray(subscriptions)) {
      for (const subscription of subscriptions) {
        if (subscription?.id) {
          planNameBySubscriptionId.set(String(subscription.id), asTrimmedString(subscription.plan_key));
        }
      }
    }
  }

  const paymentIds = rows.map((row) => String(row.id));
  const renewalByPaymentId = new Map();
  if (paymentIds.length > 0) {
    try {
      const { data: cycles, error: cyclesError } = await supabase
        .from("billing_renewal_cycles")
        .select("id, generated_payment_id, renewal_status")
        .eq("user_id", userId)
        .in("generated_payment_id", paymentIds);
      if (!cyclesError && Array.isArray(cycles)) {
        for (const cycle of cycles) {
          if (cycle?.generated_payment_id) {
            renewalByPaymentId.set(String(cycle.generated_payment_id), {
              renewal_cycle_id: String(cycle.id),
              renewal_status: asTrimmedString(cycle.renewal_status),
            });
          }
        }
      } else if (cyclesError && !isMissingRelationError(cyclesError)) {
        console.error("[billing/payments] renewal_cycles_lookup_failed", {
          user_id: userId,
          error_message: cyclesError?.message,
          error_code: cyclesError?.code,
        });
      }
    } catch (renewalLookupError) {
      console.error("[billing/payments] renewal_cycles_lookup_failed", {
        user_id: userId,
        error_message: renewalLookupError instanceof Error ? renewalLookupError.message : String(renewalLookupError),
      });
    }
  }

  /** @type {BillingPaymentHistoryRow[]} */
  const mapped = [];
  for (const row of rows) {
    try {
      mapped.push(
        mapPaymentHistoryRow(
          /** @type {Record<string, unknown>} */ (row),
          planNameBySubscriptionId,
          renewalByPaymentId
        )
      );
    } catch (rowError) {
      console.error("[billing/payments] row_map_failed", {
        user_id: userId,
        payment_id: row?.id,
        error_message: rowError instanceof Error ? rowError.message : String(rowError),
      });
    }
  }
  return mapped;
}
