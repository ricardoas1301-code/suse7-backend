// ======================================================================
// POST notice-seen — anti-spam state
// ======================================================================

import { RENEWAL_ENGINE_LOG } from "../billingConstants.js";
import { logBilling } from "../billingLog.js";
import { getRenewalCycleForUser } from "./billingRenewalCycleRepository.js";
import { getRenewalNoticeState, upsertRenewalNoticeState } from "./billingRenewalNoticeStateRepository.js";

const ALLOWED_EVENTS = new Set(["popup_shown", "popup_dismissed", "banner_dismissed"]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   renewalCycleId: string;
 *   event: string;
 *   level?: string | null;
 * }} input
 */
export async function recordRenewalNoticeEvent(supabase, input) {
  const event = String(input.event || "").trim();
  if (!ALLOWED_EVENTS.has(event)) {
    const err = new Error("INVALID_NOTICE_EVENT");
    /** @type {any} */ (err).code = "INVALID_NOTICE_EVENT";
    throw err;
  }

  const cycle = await getRenewalCycleForUser(supabase, input.renewalCycleId, input.userId);
  if (!cycle) {
    const err = new Error("RENEWAL_CYCLE_NOT_FOUND");
    /** @type {any} */ (err).code = "RENEWAL_CYCLE_NOT_FOUND";
    throw err;
  }

  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const patch = {
    last_alert_level_seen: input.level ?? null,
  };

  const existing = await getRenewalNoticeState(supabase, input.userId, input.renewalCycleId);

  if (event === "popup_shown") {
    patch.last_popup_shown_at = now;
    patch.popup_shown_count = Number(existing?.popup_shown_count ?? 0) + 1;
  }
  if (event === "popup_dismissed") {
    patch.last_popup_shown_at = now;
  }
  if (event === "banner_dismissed") {
    patch.last_banner_dismissed_at = now;
  }

  const state = await upsertRenewalNoticeState(supabase, input.userId, input.renewalCycleId, patch);

  logBilling("billing", RENEWAL_ENGINE_LOG.NOTICE_STATE_UPDATED, {
    user_id: input.userId,
    renewal_cycle_id: input.renewalCycleId,
    event,
    level: input.level ?? null,
  });

  return { ok: true, state };
}
