// =============================================================================
// Resolve template por categoria/tipo/canal
// =============================================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   templateKey?: string | null;
 *   category: string;
 *   type: string;
 *   channel: string;
 *   locale?: string;
 * }} input
 */
export async function resolveNotificationTemplate(supabase, input) {
  const locale = input.locale ?? "pt-BR";
  const channel = String(input.channel ?? "").trim();

  if (input.templateKey) {
    const { data, error } = await supabase
      .from("s7_notification_templates")
      .select("*")
      .eq("template_key", input.templateKey)
      .eq("channel", channel)
      .eq("locale", locale)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  const { data: byType, error: err2 } = await supabase
    .from("s7_notification_templates")
    .select("*")
    .eq("category_code", input.category)
    .eq("type_key", input.type)
    .eq("channel", channel)
    .eq("locale", locale)
    .eq("is_active", true)
    .maybeSingle();

  if (err2) throw err2;
  return byType;
}
