// ======================================================================
// Motor de alertas de renovação + grace period — Fase 2.1
// ======================================================================

import {
  BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT,
  PAYMENT_HISTORY_ACTION_TYPE,
  RENEWAL_ALERT_LEVEL,
  RENEWAL_ENGINE_LOG,
  RENEWAL_POPUP_FREQUENCY,
  RENEWAL_STATUS,
  RENEWAL_STRATEGY,
} from "../billingConstants.js";
import { logBilling } from "../billingLog.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { isManualRenewalStrategy } from "./billingPendingRenewalPresentationService.js";
import { daysUntilRenewalDue } from "./billingRenewalCycleRepository.js";
import { getRenewalNoticeState } from "./billingRenewalNoticeStateRepository.js";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function resolveGraceDaysTotal() {
  const raw = Number(process.env.BILLING_RENEWAL_GRACE_PERIOD_DAYS ?? BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT;
}

/**
 * @param {number | null} daysUntil
 */
export function computeRenewalTimeline(daysUntil) {
  if (daysUntil == null) {
    return { days_until_due: null, days_overdue: null, grace_days_remaining: null };
  }
  if (daysUntil >= 0) {
    return {
      days_until_due: daysUntil,
      days_overdue: 0,
      grace_days_remaining: null,
    };
  }
  const daysOverdue = Math.abs(daysUntil);
  const graceTotal = resolveGraceDaysTotal();
  return {
    days_until_due: 0,
    days_overdue: daysOverdue,
    grace_days_remaining: Math.max(0, graceTotal - daysOverdue),
  };
}

/**
 * @param {number | null} daysUntil
 * @param {number} daysOverdue
 * @param {string} renewalStatus
 */
export function resolveRenewalAlertLevel(daysUntil, daysOverdue, renewalStatus) {
  if (renewalStatus === RENEWAL_STATUS.SUSPENDED) {
    return RENEWAL_ALERT_LEVEL.SUSPENDED;
  }

  if (daysOverdue > resolveGraceDaysTotal()) {
    return RENEWAL_ALERT_LEVEL.SUSPENDED;
  }

  if (daysOverdue > 0) {
    if (daysOverdue >= 10) return RENEWAL_ALERT_LEVEL.CRITICAL_FINAL;
    if (daysOverdue >= 9) return RENEWAL_ALERT_LEVEL.CRITICAL;
    if (daysOverdue >= 7) return RENEWAL_ALERT_LEVEL.CRITICAL;
    if (daysOverdue >= 5) return RENEWAL_ALERT_LEVEL.DANGER;
    if (daysOverdue >= 3) return RENEWAL_ALERT_LEVEL.DANGER;
    return RENEWAL_ALERT_LEVEL.WARNING;
  }

  if (daysUntil === 1) return RENEWAL_ALERT_LEVEL.CRITICAL;
  if (daysUntil === 2) return RENEWAL_ALERT_LEVEL.DANGER;
  if (daysUntil === 3) return RENEWAL_ALERT_LEVEL.WARNING;

  return RENEWAL_ALERT_LEVEL.INFO;
}

/**
 * @param {string} level
 * @param {number | null} daysUntil
 * @param {number} daysOverdue
 * @param {number | null} graceDaysRemaining
 */
export function resolveRenewalNoticeCopy(level, daysUntil, daysOverdue, graceDaysRemaining) {
  if (level === RENEWAL_ALERT_LEVEL.SUSPENDED) {
    return {
      title: "Assinatura suspensa",
      message:
        "Seu período de tolerância terminou. Regularize sua assinatura para reativar o acesso ao Suse7.",
    };
  }

  if (level === RENEWAL_ALERT_LEVEL.CRITICAL_FINAL) {
    return {
      title: "Último dia antes da suspensão",
      message: "Regularize sua assinatura hoje para evitar o bloqueio do acesso operacional ao Suse7.",
    };
  }

  if (daysOverdue > 0) {
    if (daysOverdue >= 9) {
      return {
        title: "Último aviso antes da suspensão",
        message: `Faltam ${graceDaysRemaining ?? 1} dia(s) de tolerância. Renove agora para manter seu acesso.`,
      };
    }
    if (daysOverdue >= 7) {
      return {
        title: "Risco de bloqueio do acesso",
        message: "Seu plano está em atraso. Renove agora para evitar a suspensão da assinatura.",
      };
    }
    if (daysOverdue >= 5) {
      return {
        title: "Renovação em atraso",
        message: "Seu acesso ainda está liberado durante o período de tolerância. Renove o plano atual agora.",
      };
    }
    if (daysOverdue >= 3) {
      return {
        title: "Plano em atraso",
        message: "Evite interrupções. Renove seu plano atual para manter monitoramentos e automações.",
      };
    }
    return {
      title: "Plano vencido — período de tolerância",
      message: "Renove agora para manter seu acesso e monitoramentos ativos durante o grace period.",
    };
  }

  if (daysUntil === 1) {
    return {
      title: "Seu plano vence amanhã",
      message: "Renove agora para manter seu acesso, automações e monitoramentos ativos.",
    };
  }
  if (daysUntil === 2) {
    return {
      title: "Faltam 2 dias para a renovação",
      message: "Evite interrupções no acesso ao Suse7. Renove seu plano atual.",
    };
  }
  if (daysUntil === 3) {
    return {
      title: "Seu plano vence em breve",
      message: "Renove seu plano para manter seus monitoramentos ativos.",
    };
  }

  return {
    title: "Renovação do plano",
    message: "Acompanhe a renovação do seu plano atual no Suse7.",
  };
}

/**
 * @param {string} level
 */
export function resolveRenewalPopupPolicy(level) {
  if (level === RENEWAL_ALERT_LEVEL.SUSPENDED || level === RENEWAL_ALERT_LEVEL.CRITICAL_FINAL) {
    return { frequency: RENEWAL_POPUP_FREQUENCY.ALWAYS_CRITICAL, dismissible: false };
  }
  if (level === RENEWAL_ALERT_LEVEL.CRITICAL) {
    return { frequency: RENEWAL_POPUP_FREQUENCY.ON_LOGIN, dismissible: true };
  }
  if (level === RENEWAL_ALERT_LEVEL.DANGER) {
    return { frequency: RENEWAL_POPUP_FREQUENCY.EVERY_12_HOURS, dismissible: true };
  }
  if (level === RENEWAL_ALERT_LEVEL.WARNING) {
    return { frequency: RENEWAL_POPUP_FREQUENCY.ONCE_PER_DAY, dismissible: true };
  }
  return { frequency: RENEWAL_POPUP_FREQUENCY.ONCE_PER_DAY, dismissible: true };
}

/**
 * @param {string | null | undefined} lastShownAt
 * @param {string} frequency
 * @param {Date} now
 */
export function shouldShowPopupByFrequency(lastShownAt, frequency, now) {
  if (frequency === RENEWAL_POPUP_FREQUENCY.ALWAYS_CRITICAL) return true;
  if (!lastShownAt) return true;

  const last = new Date(lastShownAt);
  if (Number.isNaN(last.getTime())) return true;
  const elapsed = now.getTime() - last.getTime();

  if (frequency === RENEWAL_POPUP_FREQUENCY.ONCE_PER_DAY) {
    return elapsed >= MS_PER_DAY;
  }
  if (frequency === RENEWAL_POPUP_FREQUENCY.EVERY_12_HOURS) {
    return elapsed >= 12 * MS_PER_HOUR;
  }
  if (frequency === RENEWAL_POPUP_FREQUENCY.EVERY_6_HOURS) {
    return elapsed >= 6 * MS_PER_HOUR;
  }
  if (frequency === RENEWAL_POPUP_FREQUENCY.ON_LOGIN) {
    const lastDay = last.toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    return lastDay < today;
  }
  return true;
}

/**
 * @param {string | null | undefined} lastDismissedAt
 * @param {string} level
 * @param {Date} now
 */
function shouldShowBannerAfterDismiss(lastDismissedAt, level, now) {
  if (level === RENEWAL_ALERT_LEVEL.CRITICAL_FINAL || level === RENEWAL_ALERT_LEVEL.SUSPENDED) {
    return true;
  }
  if (!lastDismissedAt) return true;
  const dismissed = new Date(lastDismissedAt);
  if (Number.isNaN(dismissed.getTime())) return true;
  return now.getTime() - dismissed.getTime() >= MS_PER_DAY;
}

/**
 * @param {string} level
 * @param {string} strategy
 * @param {string} renewalStatus
 */
function resolveRenewalNoticeActions(level, strategy, renewalStatus) {
  if (level === RENEWAL_ALERT_LEVEL.SUSPENDED) {
    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.PAY_RENEWAL, action_label: "Regularizar assinatura" };
  }
  if (
    strategy === RENEWAL_STRATEGY.AUTO_CARD &&
    (renewalStatus === RENEWAL_STATUS.PAYMENT_FAILED || renewalStatus === RENEWAL_STATUS.GRACE_PERIOD)
  ) {
    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.UPDATE_CARD, action_label: "Atualizar cartão" };
  }
  return { action_type: PAYMENT_HISTORY_ACTION_TYPE.PAY_RENEWAL, action_label: "Renovar agora" };
}

/**
 * @param {string} level
 * @param {number | null} daysUntil
 * @param {number} daysOverdue
 */
function isNoticeRelevantForTimeline(level, daysUntil, daysOverdue) {
  if (level === RENEWAL_ALERT_LEVEL.SUSPENDED || level === RENEWAL_ALERT_LEVEL.CRITICAL_FINAL) {
    return true;
  }
  if (daysOverdue > 0) return true;
  return daysUntil != null && daysUntil >= 1 && daysUntil <= 3;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown> | null} activeSubscription
 * @param {Record<string, unknown> | null} cycle
 * @param {{ strategy?: string }} [options]
 * @param {Date} [now]
 */
export async function computeRenewalNotice(supabase, userId, activeSubscription, cycle, options = {}, now = new Date()) {
  if (!activeSubscription?.id || !cycle?.id) return null;

  const strategy = String(options.strategy ?? cycle.renewal_strategy ?? "");
  const renewalStatus = String(cycle.renewal_status ?? "");

  if (cycle.generated_payment_id && renewalStatus !== RENEWAL_STATUS.SUSPENDED) {
    return null;
  }

  const manual = isManualRenewalStrategy(strategy);
  const autoCard = strategy === RENEWAL_STRATEGY.AUTO_CARD;
  if (!manual && !autoCard) return null;

  if (autoCard && renewalStatus !== RENEWAL_STATUS.PAYMENT_FAILED && renewalStatus !== RENEWAL_STATUS.GRACE_PERIOD) {
    if (renewalStatus !== RENEWAL_STATUS.PRE_RENEWAL && renewalStatus !== RENEWAL_STATUS.PENDING_PAYMENT) {
      const daysUntil = daysUntilRenewalDue(cycle.renewal_due_date, now);
      if (daysUntil == null || daysUntil > 3 || daysUntil < 0) {
        return null;
      }
    }
  }

  const daysUntilRaw = daysUntilRenewalDue(cycle.renewal_due_date, now);
  const timeline = computeRenewalTimeline(daysUntilRaw);
  const level = resolveRenewalAlertLevel(daysUntilRaw, timeline.days_overdue ?? 0, renewalStatus);

  if (!isNoticeRelevantForTimeline(level, timeline.days_until_due, timeline.days_overdue ?? 0)) {
    return null;
  }

  const copy = resolveRenewalNoticeCopy(
    level,
    timeline.days_until_due,
    timeline.days_overdue ?? 0,
    timeline.grace_days_remaining
  );
  const actions = resolveRenewalNoticeActions(level, strategy, renewalStatus);
  const popupPolicy = resolveRenewalPopupPolicy(level);

  const noticeState = await getRenewalNoticeState(supabase, userId, String(cycle.id));
  const shouldShowPopup =
    shouldShowPopupByFrequency(noticeState?.last_popup_shown_at, popupPolicy.frequency, now) &&
    level !== RENEWAL_ALERT_LEVEL.INFO;

  const shouldShowBanner = shouldShowBannerAfterDismiss(noticeState?.last_banner_dismissed_at, level, now);

  const plan = await getActivePlanById(supabase, String(activeSubscription.plan_id));

  const notice = {
    level,
    title: copy.title,
    message: copy.message,
    action_type: actions.action_type,
    action_label: actions.action_label,
    should_show_banner: shouldShowBanner,
    should_show_popup: shouldShowPopup,
    popup_policy: popupPolicy,
    days_until_due: timeline.days_until_due,
    days_overdue: timeline.days_overdue,
    grace_days_total: resolveGraceDaysTotal(),
    grace_days_remaining: timeline.grace_days_remaining,
    renewal_cycle_id: String(cycle.id),
    renewal_status: renewalStatus,
    renewal_strategy: strategy,
    plan_key: String(cycle.current_plan_key),
    plan_name: plan?.name ?? cycle.current_plan_key,
    amount: plan?.price_monthly ?? activeSubscription.amount ?? null,
    current_period_end: activeSubscription.current_period_end ?? null,
    renewal_due_date: cycle.renewal_due_date,
  };

  logBilling("billing", RENEWAL_ENGINE_LOG.NOTICE_COMPUTED, {
    user_id: userId,
    renewal_cycle_id: cycle.id,
    level,
    days_until_due: timeline.days_until_due,
    days_overdue: timeline.days_overdue,
    should_show_banner: shouldShowBanner,
    should_show_popup: shouldShowPopup,
  });

  return notice;
}
