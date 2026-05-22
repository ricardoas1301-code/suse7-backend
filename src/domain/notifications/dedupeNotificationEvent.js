// ============================================================
// shouldCreateNotificationEvent — anti-spam por fingerprint + janela
// ============================================================

import { getDedupeWindowMsForSeverity } from "./notificationDedupeConfig.js";
import { NOTIFICATION_SEVERITIES } from "./notificationSeverity.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string,
 *   fingerprint: string,
 *   severity: string,
 *   skipDedupe?: boolean,
 * }} args
 * @returns {Promise<{ allow: boolean, reason?: string }>}
 */
export async function shouldCreateNotificationEvent(supabase, args) {
  if (args.skipDedupe) {
    return { allow: true, reason: "skip_dedupe" };
  }

  const severity = args.severity != null ? String(args.severity).trim().toLowerCase() : NOTIFICATION_SEVERITIES.info;
  if (severity === NOTIFICATION_SEVERITIES.critical) {
    return { allow: true, reason: "severity_critical" };
  }

  const windowMs = getDedupeWindowMsForSeverity(severity);
  if (windowMs <= 0) {
    return { allow: true, reason: "zero_window" };
  }

  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const fp = String(args.fingerprint ?? "").trim();
  const uid = String(args.userId ?? "").trim();
  if (!fp || !uid) {
    return { allow: true, reason: "missing_fingerprint_or_user" };
  }

  const { data, error } = await supabase
    .from("notification_events")
    .select("id")
    .eq("user_id", uid)
    .eq("fingerprint", fp)
    .gte("created_at", cutoff)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[S7_NOTIFICATION_DEDUPE_QUERY_ERR]", { message: error.message });
    return { allow: true, reason: "dedupe_query_failed_open" };
  }

  if (data?.id) {
    return { allow: false, reason: "dedupe_recent_fingerprint" };
  }

  return { allow: true, reason: "dedupe_ok" };
}
