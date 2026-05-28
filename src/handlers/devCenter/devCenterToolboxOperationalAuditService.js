import { sanitizeBillingAuditValue } from "../../billing/utils/billingAuditSanitize.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   subscriptionId?: string | null;
 *   operatorUserId: string;
 *   operatorEmail?: string | null;
 *   operationType: string;
 *   reason: string;
 *   payload?: Record<string, unknown>;
 *   status: "success" | "error" | "blocked";
 *   errorCode?: string | null;
 * }} input
 */
export async function registrarAuditoriaOperacionalToolbox(supabase, input) {
  const row = {
    seller_id: input.sellerId,
    subscription_id: input.subscriptionId ?? null,
    operator_user_id: input.operatorUserId,
    operator_email: input.operatorEmail ?? null,
    operation_type: input.operationType,
    reason: String(input.reason ?? "").trim(),
    payload: sanitizeBillingAuditValue(input.payload ?? {}),
    status: input.status,
    error_code: input.errorCode ?? null,
  };

  const { data, error } = await supabase
    .from("dev_center_toolbox_operational_audit")
    .insert(row)
    .select("id, created_at")
    .single();

  if (error) {
    console.warn("[dev-center-toolbox-audit] insert_failed", {
      message: error.message,
      operationType: input.operationType,
      sellerId: input.sellerId,
    });
    return null;
  }

  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{ limit?: number }} [opts]
 */
export async function listarAuditoriaOperacionalToolbox(supabase, sellerId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);

  const { data, error } = await supabase
    .from("dev_center_toolbox_operational_audit")
    .select(
      "id, seller_id, subscription_id, operator_user_id, operator_email, operation_type, status, error_code, payload, created_at",
    )
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (String(error.code ?? "") === "42P01") return [];
    throw error;
  }

  return Array.isArray(data) ? data : [];
}
