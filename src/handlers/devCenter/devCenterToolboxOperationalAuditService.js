import { sanitizeBillingAuditValue } from "../../billing/utils/billingAuditSanitize.js";

function isDevToolboxAuditLoggingEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.S7_APP_ENV === "development";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   subscriptionId?: string | null;
 *   marketplaceAccountId?: string | null;
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
    marketplace_account_id: input.marketplaceAccountId ?? null,
    operator_user_id: input.operatorUserId,
    operator_email: input.operatorEmail ?? null,
    operation_type: input.operationType,
    reason: String(input.reason ?? "").trim(),
    payload: sanitizeBillingAuditValue(input.payload ?? {}),
    status: input.status,
    error_code: input.errorCode ?? null,
  };

  if (isDevToolboxAuditLoggingEnabled()) {
    console.info("[dev-center-toolbox-audit] insert_start", {
      operationType: input.operationType,
      status: input.status,
      sellerId: input.sellerId,
      subscriptionId: input.subscriptionId ?? null,
      operatorUserId: input.operatorUserId,
      payloadKeys: Object.keys(row.payload ?? {}),
    });
  }

  const { data, error } = await supabase
    .from("dev_center_toolbox_operational_audit")
    .insert(row)
    .select("id, created_at")
    .single();

  if (error) {
    console.warn("[dev-center-toolbox-audit] insert_failed", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      operationType: input.operationType,
      sellerId: input.sellerId,
      status: input.status,
    });
    return null;
  }

  if (isDevToolboxAuditLoggingEnabled()) {
    console.info("[dev-center-toolbox-audit] insert_ok", {
      id: data?.id ?? null,
      createdAt: data?.created_at ?? null,
      operationType: input.operationType,
      status: input.status,
      sellerId: input.sellerId,
    });
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
