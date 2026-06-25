// ======================================================================
// Repositório — billing_renewal_notice_state (anti-spam)
// ======================================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} renewalCycleId
 */
export async function getRenewalNoticeState(supabase, userId, renewalCycleId) {
  const { data, error } = await supabase
    .from("billing_renewal_notice_state")
    .select("*")
    .eq("user_id", userId)
    .eq("renewal_cycle_id", renewalCycleId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} renewalCycleId
 */
export async function upsertRenewalNoticeState(supabase, userId, renewalCycleId, patch) {
  const existing = await getRenewalNoticeState(supabase, userId, renewalCycleId);
  const now = new Date().toISOString();

  if (!existing) {
    const { data, error } = await supabase
      .from("billing_renewal_notice_state")
      .insert({
        user_id: userId,
        renewal_cycle_id: renewalCycleId,
        ...patch,
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("billing_renewal_notice_state")
    .update({ ...patch, updated_at: now })
    .eq("id", existing.id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
