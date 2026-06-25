// ============================================================
// Provider App / sininho — persiste em `notifications` (sem SMTP/API externa)
// ============================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string,
 *   deliveryId: string,
 *   notificationEventId: string,
 *   notificationType: string,
 *   title: string,
 *   message: string,
 *   payload?: Record<string, unknown>,
 * }} args
 * @returns {Promise<{ success: boolean, providerMessageId?: string | null, raw?: unknown, permanentFailure?: boolean }>}
 */
export async function sendAppBellNotification(supabase, args) {
  const payload = {
    title: args.title,
    message: args.message,
    notification_event_id: args.notificationEventId,
    delivery_id: args.deliveryId,
    ...(args.payload && typeof args.payload === "object" ? args.payload : {}),
  };

  const row = {
    user_id: args.userId,
    type: args.notificationType,
    payload,
    dedupe_key: `s7_delivery:${args.deliveryId}`,
    notification_event_id: args.notificationEventId,
  };

  let { data, error } = await supabase.from("notifications").insert(row).select("id").maybeSingle();

  if (error?.code === "42703" || String(error?.message ?? "").includes("notification_event_id")) {
    const { user_id, type, payload: pl, dedupe_key } = row;
    ({ data, error } = await supabase
      .from("notifications")
      .insert({ user_id, type, payload: pl, dedupe_key })
      .select("id")
      .maybeSingle());
  }

  if (error) {
    console.error("[S7_NOTIFICATION][app_provider_insert_err]", { message: error.message });
    return { success: false, raw: error };
  }

  return {
    success: true,
    providerMessageId: data?.id != null ? String(data.id) : null,
    raw: { notification_row_id: data?.id ?? null },
  };
}
