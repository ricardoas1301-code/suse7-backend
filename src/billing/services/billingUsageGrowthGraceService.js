// ======================================================================
// Grace de crescimento (limite mensal) — estrutura para política de 30 dias
// ======================================================================

import {
  BILLING_USAGE_GROWTH_GRACE_PERIOD_DAYS_DEFAULT,
  USAGE_GROWTH_GRACE_METADATA_KEYS,
  USAGE_GROWTH_GRACE_STATUS,
} from "../billingConstants.js";

export const USAGE_GROWTH_UX_COPY = {
  title: "Sua operação está crescendo 🚀",
  message:
    "Parabéns! Seu volume de vendas ultrapassou o limite do plano atual. Para acompanhar esse crescimento com segurança, o Suse7 manterá seu acesso por mais 30 dias. Se sua operação continuar acima desse volume ao final desse período, vamos recomendar o plano ideal para o seu momento.",
  ctaPrimary: "Entendi",
  ctaSecondary: "Ver planos",
};

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 * @param {Date} [now]
 */
export function readUsageGrowthGrace(metadata, now = new Date()) {
  const meta = asObject(metadata) ?? {};
  const status = String(meta[USAGE_GROWTH_GRACE_METADATA_KEYS.USAGE_GRACE_STATUS] || USAGE_GROWTH_GRACE_STATUS.NONE);
  const endsAtRaw = meta[USAGE_GROWTH_GRACE_METADATA_KEYS.GRACE_PERIOD_ENDS_AT];
  const endsAt = endsAtRaw ? new Date(String(endsAtRaw)) : null;
  const active =
    status === USAGE_GROWTH_GRACE_STATUS.ACTIVE &&
    endsAt != null &&
    !Number.isNaN(endsAt.getTime()) &&
    endsAt.getTime() > now.getTime();

  return {
    usage_limit_exceeded_at: meta[USAGE_GROWTH_GRACE_METADATA_KEYS.USAGE_LIMIT_EXCEEDED_AT] ?? null,
    grace_period_started_at: meta[USAGE_GROWTH_GRACE_METADATA_KEYS.GRACE_PERIOD_STARTED_AT] ?? null,
    grace_period_ends_at: endsAtRaw ?? null,
    usage_grace_status: active ? USAGE_GROWTH_GRACE_STATUS.ACTIVE : status,
    upgrade_required_after_grace: Boolean(meta[USAGE_GROWTH_GRACE_METADATA_KEYS.UPGRADE_REQUIRED_AFTER_GRACE]),
    grace_active: active,
    grace_period_days: BILLING_USAGE_GROWTH_GRACE_PERIOD_DAYS_DEFAULT,
  };
}

/**
 * Aplica política de tolerância: durante grace de crescimento, não bloquear por limite.
 *
 * @param {boolean} hardBlockedByUsage
 * @param {boolean} exceeded
 * @param {ReturnType<typeof readUsageGrowthGrace>} growthGrace
 */
export function applyUsageGrowthGraceToAccess(hardBlockedByUsage, exceeded, growthGrace) {
  if (!exceeded) {
    return {
      hard_blocked: false,
      growth_grace: growthGrace,
      show_growth_notice: false,
    };
  }
  if (growthGrace.grace_active) {
    return {
      hard_blocked: false,
      growth_grace: growthGrace,
      show_growth_notice: true,
    };
  }
  return {
    hard_blocked: hardBlockedByUsage,
    growth_grace: growthGrace,
    show_growth_notice: false,
  };
}

/**
 * Payload sugerido ao iniciar grace (persistência futura em metadata).
 *
 * @param {Date} [now]
 */
export function buildUsageGrowthGraceStartPatch(now = new Date()) {
  const ends = new Date(now.getTime());
  ends.setUTCDate(ends.getUTCDate() + BILLING_USAGE_GROWTH_GRACE_PERIOD_DAYS_DEFAULT);
  return {
    [USAGE_GROWTH_GRACE_METADATA_KEYS.USAGE_LIMIT_EXCEEDED_AT]: now.toISOString(),
    [USAGE_GROWTH_GRACE_METADATA_KEYS.GRACE_PERIOD_STARTED_AT]: now.toISOString(),
    [USAGE_GROWTH_GRACE_METADATA_KEYS.GRACE_PERIOD_ENDS_AT]: ends.toISOString(),
    [USAGE_GROWTH_GRACE_METADATA_KEYS.USAGE_GRACE_STATUS]: USAGE_GROWTH_GRACE_STATUS.ACTIVE,
    [USAGE_GROWTH_GRACE_METADATA_KEYS.UPGRADE_REQUIRED_AFTER_GRACE]: false,
  };
}
