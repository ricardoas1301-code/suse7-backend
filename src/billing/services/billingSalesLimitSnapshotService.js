// ======================================================================
// Materialização do sales_limit_snapshot — catálogo → ciclo aberto (S1.HF.6.9A.5)
// ======================================================================

import { BILLING_USAGE_LIMIT_METADATA_KEYS } from "../billingConstants.js";

/**
 * @param {string | null | undefined} planKey
 */
export function normalizePlanKeyForCatalog(planKey) {
  const key = planKey != null ? String(planKey).trim().toLowerCase() : "";
  if (!key || key === "baby_internal_free") return "baby";
  return key;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planKey
 */
export async function readPlanSalesLimitMonthlyFromCatalog(supabase, planKey) {
  const catalogKey = normalizePlanKeyForCatalog(planKey);
  const { data, error } = await supabase
    .from("plans")
    .select("sales_limit_monthly, plan_key")
    .eq("plan_key", catalogKey)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  const limit = data?.sales_limit_monthly != null ? Number(data.sales_limit_monthly) : null;
  if (!Number.isFinite(limit) || limit <= 0) {
    const err = new Error("BILLING_PLAN_SALES_LIMIT_MISSING");
    err.code = "BILLING_PLAN_SALES_LIMIT_MISSING";
    throw err;
  }
  return limit;
}

/**
 * @param {string} cycleKey
 * @param {number} salesLimit
 */
export function buildSalesLimitSnapshotMetadataPatch(cycleKey, salesLimit) {
  const cycle = String(cycleKey ?? "").trim();
  if (!cycle) {
    const err = new Error("BILLING_CYCLE_KEY_REQUIRED");
    err.code = "BILLING_CYCLE_KEY_REQUIRED";
    throw err;
  }
  return {
    [BILLING_USAGE_LIMIT_METADATA_KEYS.CYCLE_KEY]: cycle,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.SALES_LIMIT_SNAPSHOT]: salesLimit,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.SALES_LIMIT_SNAPSHOT_CYCLE_KEY]: cycle,
    sales_limit_snapshot_materialized_at: new Date().toISOString(),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planKey
 * @param {string} cycleKey
 */
export async function buildSalesLimitSnapshotPatchFromCatalog(supabase, planKey, cycleKey) {
  const salesLimit = await readPlanSalesLimitMonthlyFromCatalog(supabase, planKey);
  return buildSalesLimitSnapshotMetadataPatch(cycleKey, salesLimit);
}
