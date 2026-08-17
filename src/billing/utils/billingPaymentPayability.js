// ======================================================================
// Cobrança pagável — validação compartilhada (histórico, Pix, boleto)
// ======================================================================

/**
 * @param {unknown} status
 */
export function normalizeBillingPaymentStatusKey(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw) return "PENDING";
  if (["received", "confirmed", "received_in_cash", "paid", "pago"].includes(raw)) return "PAID";
  if (["pending", "pendente", "awaiting_payment"].includes(raw)) return "PENDING";
  if (["overdue", "vencido", "past_due"].includes(raw)) return "OVERDUE";
  if (["canceled", "cancelled", "deleted", "cancelado"].includes(raw)) return "CANCELED";
  if (["refunded", "estornado", "refund"].includes(raw)) return "REFUNDED";
  if (["failed", "falhou", "chargeback", "chargeback_requested"].includes(raw)) return "FAILED";
  return raw.toUpperCase();
}

/**
 * @param {unknown} status
 */
export function isBillingPaymentPayable(status) {
  const key = normalizeBillingPaymentStatusKey(status);
  return key === "PENDING" || key === "OVERDUE";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} providerPaymentId
 */
export async function assertBillingPaymentPayableForUser(supabase, userId, providerPaymentId) {
  const payId = String(providerPaymentId || "").trim();
  if (!payId) {
    return { ok: false, code: "VALIDATION_ERROR", message: "Informe provider_payment_id." };
  }

  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, user_id, status")
    .eq("provider", "asaas")
    .eq("provider_payment_id", payId)
    .limit(1);

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : null;
  if (!row || String(row.user_id) !== userId) {
    return { ok: false, code: "PAYMENT_NOT_FOUND", message: "Cobrança não encontrada." };
  }

  if (!isBillingPaymentPayable(row.status)) {
    const statusKey = normalizeBillingPaymentStatusKey(row.status);
    return {
      ok: false,
      code: "PAYMENT_NOT_PAYABLE",
      message:
        statusKey === "PAID"
          ? "Esta cobrança já foi paga e não aceita novo pagamento."
          : "Esta cobrança não está disponível para pagamento.",
      status_key: statusKey,
    };
  }

  return { ok: true, payment_id: String(row.id), status_key: normalizeBillingPaymentStatusKey(row.status) };
}
