// ======================================================================

// Renovação pendente — delega ao notice engine (Fase 2.1)

// ======================================================================



import { RENEWAL_STRATEGY } from "../billingConstants.js";

import { findOpenRenewalCycleForSubscription } from "./billingRenewalCycleRepository.js";

import { computeRenewalNotice } from "./billingRenewalNoticeEngine.js";

import { resolveRenewalStrategyForSubscription } from "./billingRenewalStrategyService.js";



const MANUAL_STRATEGIES = new Set([

  RENEWAL_STRATEGY.MANUAL_PIX,

  RENEWAL_STRATEGY.MANUAL_BOLETO,

  RENEWAL_STRATEGY.MANUAL_CARD,

  RENEWAL_STRATEGY.HYBRID,

]);



/**

 * @param {string} strategy

 */

export function isManualRenewalStrategy(strategy) {

  return MANUAL_STRATEGIES.has(String(strategy));

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {Record<string, unknown> | null} activeSubscription

 * @param {Date} [now]

 */

export async function resolvePendingRenewalPresentation(supabase, userId, activeSubscription, now = new Date()) {

  if (!activeSubscription?.id) return null;



  const cycle = await findOpenRenewalCycleForSubscription(supabase, String(activeSubscription.id));

  if (!cycle) return null;



  const strategyInfo = await resolveRenewalStrategyForSubscription(supabase, activeSubscription);

  const notice = await computeRenewalNotice(

    supabase,

    userId,

    activeSubscription,

    cycle,

    { strategy: strategyInfo.strategy },

    now

  );

  if (!notice || !notice.should_show_banner) return null;



  return {

    renewal_cycle_id: notice.renewal_cycle_id,

    renewal_status: notice.renewal_status,

    renewal_strategy: notice.renewal_strategy,

    plan_key: notice.plan_key,

    plan_name: notice.plan_name,

    amount: notice.amount,

    current_period_end: notice.current_period_end,

    renewal_due_date: notice.renewal_due_date,

    days_until_due: notice.days_until_due,

    days_overdue: notice.days_overdue,

    grace_days_remaining: notice.grace_days_remaining,

    banner_title: notice.title,

    banner_subtitle: notice.message,

    action_type: notice.action_type,

    action_label: notice.action_label,

    level: notice.level,

  };

}


