import { sanitizeBillingAuditValue } from "../../billing/utils/billingAuditSanitize.js";
import { buildToolboxOperationalAuditContext } from "./devCenterToolboxOperationalAuditModel.js";

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
 *   beforeState?: Record<string, unknown> | null;
 *   afterState?: Record<string, unknown> | null;
 *   entityType?: string | null;
 *   entityId?: string | null;
 *   category?: string | null;
 * }} input
 */
export async function registrarAuditoriaOperacionalToolbox(supabase, input) {
  const auditContext = buildToolboxOperationalAuditContext({
    operationType: input.operationType,
    beforeState: input.beforeState,
    afterState: input.afterState,
    entityType: input.entityType,
    entityId: input.entityId,
    category: input.category,
    marketplaceAccountId: input.marketplaceAccountId,
    subscriptionId: input.subscriptionId,
  });

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
    before_state: auditContext.beforeState,
    after_state: auditContext.afterState,
    changed_fields: auditContext.changedFields,
    entity_type: auditContext.entityType,
    entity_id: auditContext.entityId,
    category: auditContext.category,
  };

  if (isDevToolboxAuditLoggingEnabled()) {
    console.info("[dev-center-toolbox-audit] insert_start", {
      operationType: input.operationType,
      status: input.status,
      sellerId: input.sellerId,
      subscriptionId: input.subscriptionId ?? null,
      marketplaceAccountId: input.marketplaceAccountId ?? null,
      category: auditContext.category,
      entityType: auditContext.entityType,
      changedFields: auditContext.changedFields,
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
      category: auditContext.category,
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
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);

  const { data, error } = await supabase
    .from("dev_center_toolbox_operational_audit")
    .select(
      "id, seller_id, subscription_id, marketplace_account_id, operator_user_id, operator_email, operation_type, category, entity_type, entity_id, status, error_code, reason, payload, before_state, after_state, changed_fields, created_at",
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
