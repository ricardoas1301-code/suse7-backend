// ======================================================================
// billingPlanRepository — leitura alinhada ao contrato real `public.plans`
// ======================================================================

/**
 * @typedef {Object} Suse7PlanRow
 * @property {string} id
 * @property {string} plan_key
 * @property {string} name
 * @property {string | number | null} price_monthly
 * @property {number | null} sales_limit_monthly
 * @property {boolean} billing_required
 * @property {boolean} is_active
 * @property {number | null} [sort_order]
 */

const PLAN_SELECT =
  "id, plan_key, name, price_monthly, sales_limit_monthly, billing_required, is_active, sort_order";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planKey
 * @returns {Promise<Suse7PlanRow | null>}
 */
export async function getActivePlanByKey(supabase, planKey) {
  const key = String(planKey || "").trim();
  if (!key || /[%_]/.test(key)) return null;
  const { data, error } = await supabase
    .from("plans")
    .select(PLAN_SELECT)
    .ilike("plan_key", key)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planId
 * @returns {Promise<Suse7PlanRow | null>}
 */
export async function getActivePlanById(supabase, planId) {
  const id = String(planId || "").trim();
  if (!id) return null;
  const { data, error } = await supabase.from("plans").select(PLAN_SELECT).eq("id", id).eq("is_active", true).maybeSingle();
  if (error) throw error;
  return data ?? null;
}
