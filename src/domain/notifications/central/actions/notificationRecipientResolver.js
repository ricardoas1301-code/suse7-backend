// =============================================================================
// Destinatários por canal — wrapper (Fase 3.5C.1.A2)
// =============================================================================

import { resolveCentralRecipients } from "../recipients/resolveCentralRecipients.js";
import { logNotificationActions } from "./notificationActionsLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   category: string;
 *   type: string;
 *   channel: string;
 *   marketplaceAccountId?: string | null;
 * }} input
 */
export async function resolveNotificationActionRecipients(supabase, input) {
  const recipients = await resolveCentralRecipients(supabase, input);
  logNotificationActions("RECIPIENTS_RESOLVED", {
    seller_id: input.sellerId,
    category: input.category,
    type: input.type,
    channel: input.channel,
    count: recipients.length,
  });
  return recipients;
}
