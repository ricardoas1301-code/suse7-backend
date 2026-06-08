// ======================================================================
// billingPlanRepository — leitura alinhada ao contrato real `public.plans`
// ======================================================================

/**
 * @typedef {Object} Suse7PlanRow
 * @property {string} id
 * @property {string} plan_key
 * @property {string} name
 * @property {string | null} [display_name]
 * @property {string | null} [marketing_name]
 * @property {string | null} [slug]
 * @property {string | number | null} price_monthly
 * @property {number | null} sales_limit_monthly
 * @property {boolean} billing_required
 * @property {boolean} is_active
 * @property {number | null} [sort_order]
 */

const PLAN_SELECT =
  "id, plan_key, name, display_name, marketing_name, slug, price_monthly, sales_limit_monthly, billing_required, is_active, sort_order";

const PLAN_SELECT_LEGACY =
  "id, plan_key, name, price_monthly, sales_limit_monthly, billing_required, is_active, sort_order";

function isMissingSchemaError(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find")
  );
}

/**
 * @param {import("@supabase/supabase-js").PostgrestError | null | undefined} error
 */
function shouldRetryLegacyPlanSelect(error) {
  return isMissingSchemaError(error);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planKey
 * @returns {Promise<Suse7PlanRow | null>}
 */
export async function getActivePlanByKey(supabase, planKey) {
  const key = String(planKey || "").trim();
  if (!key || /[%_]/.test(key)) return null;
  let { data, error } = await supabase
    .from("plans")
    .select(PLAN_SELECT)
    .ilike("plan_key", key)
    .eq("is_active", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error && shouldRetryLegacyPlanSelect(error)) {
    ({ data, error } = await supabase
      .from("plans")
      .select(PLAN_SELECT_LEGACY)
      .ilike("plan_key", key)
      .eq("is_active", true)
      .maybeSingle());
  }
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
  let { data, error } = await supabase.from("plans").select(PLAN_SELECT).eq("id", id).eq("is_active", true).maybeSingle();
  if (error && shouldRetryLegacyPlanSelect(error)) {
    ({ data, error } = await supabase
      .from("plans")
      .select(PLAN_SELECT_LEGACY)
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle());
  }
  if (error) throw error;
  return data ?? null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planSlug
 * @returns {Promise<Suse7PlanRow | null>}
 */
export async function getActivePlanBySlug(supabase, planSlug) {
  const slug = String(planSlug || "").trim();
  if (!slug || /[%_]/.test(slug)) return null;
  let { data, error } = await supabase
    .from("plans")
    .select(PLAN_SELECT)
    .ilike("slug", slug)
    .eq("is_active", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error && shouldRetryLegacyPlanSelect(error)) {
    ({ data, error } = await supabase
      .from("plans")
      .select(PLAN_SELECT_LEGACY)
      .ilike("plan_key", slug)
      .eq("is_active", true)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle());
    return data ?? null;
  }
  if (error) throw error;
  return data ?? null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<Suse7PlanRow[]>}
 */
export async function listActivePlans(supabase) {
  let { data, error } = await supabase
    .from("plans")
    .select(PLAN_SELECT)
    .eq("is_active", true)
    .order("sort_order", { ascending: true, nullsFirst: false });
  if (error && shouldRetryLegacyPlanSelect(error)) {
    ({ data, error } = await supabase
      .from("plans")
      .select(PLAN_SELECT_LEGACY)
      .eq("is_active", true)
      .order("sort_order", { ascending: true, nullsFirst: false }));
  }
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * @param {Suse7PlanRow | null | undefined} plan
 */
export function resolvePlanDisplayFields(plan) {
  if (!plan) {
    return {
      plan_name: null,
      display_name: null,
      marketing_name: null,
      slug: null,
    };
  }
  const planName = plan.name ?? null;
  const displayName = plan.display_name ?? planName;
  const marketingName = plan.marketing_name ?? displayName ?? planName;
  const slug = plan.slug ?? plan.plan_key ?? null;
  return {
    plan_name: planName,
    display_name: displayName,
    marketing_name: marketingName,
    slug,
  };
}
