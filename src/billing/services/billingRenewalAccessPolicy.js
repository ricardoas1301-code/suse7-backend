// ======================================================================
// Política de acesso — grace (liberado) vs suspensão pós-grace
// ======================================================================

import {
  DELINQUENCY_STATUS,
  RENEWAL_ACCESS_STATUS,
  RENEWAL_ALERT_LEVEL,
  RENEWAL_SUBSCRIPTION_STATUS,
} from "../billingConstants.js";

/** Rotas sempre liberadas após suspensão por renovação. */
export const RENEWAL_SUSPENDED_ALLOWED_PATH_PREFIXES = [
  "/perfil/assinatura",
  "/assinatura",
  "/billing",
  "/suporte",
  "/support",
];

/** Prefixos bloqueados (áreas operacionais). */
export const RENEWAL_SUSPENDED_BLOCKED_PATH_PREFIXES = [
  "/vendas",
  "/precific",
  "/anuncios",
  "/anúncios",
  "/produtos",
  "/concorrencia",
  "/concorrência",
  "/relatorios",
  "/relatórios",
  "/registros",
  "/dashboard",
  "/raiox",
  "/rayx",
];

/**
 * @param {Record<string, unknown> | null} renewalNotice
 * @param {Record<string, unknown> | null} access
 * @param {Record<string, unknown> | null} subscription
 */
export function resolveRenewalAccessPresentation(renewalNotice, access, subscription) {
  const meta =
    subscription?.metadata && typeof subscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (subscription.metadata)
      : {};
  const renewalSubStatus = String(meta.renewal_subscription_status || "");
  const delinquency = String(meta.delinquency_status || subscription?.delinquency_status || "");

  const level = renewalNotice?.level ? String(renewalNotice.level) : null;
  const isSuspended =
    level === RENEWAL_ALERT_LEVEL.SUSPENDED ||
    renewalSubStatus === RENEWAL_SUBSCRIPTION_STATUS.SUSPENDED ||
    delinquency === DELINQUENCY_STATUS.SUSPENDED;

  const isGrace =
    !isSuspended &&
    (level === RENEWAL_ALERT_LEVEL.WARNING ||
      level === RENEWAL_ALERT_LEVEL.DANGER ||
      level === RENEWAL_ALERT_LEVEL.CRITICAL ||
      level === RENEWAL_ALERT_LEVEL.CRITICAL_FINAL ||
      renewalSubStatus === RENEWAL_SUBSCRIPTION_STATUS.GRACE_PERIOD ||
      delinquency === DELINQUENCY_STATUS.GRACE);

  if (isSuspended) {
    return {
      subscription_status: RENEWAL_SUBSCRIPTION_STATUS.SUSPENDED,
      access_status: RENEWAL_ACCESS_STATUS.SUSPENDED,
      operational_blocked: true,
      access_restrictions: {
        operational_blocked: true,
        allowed_path_prefixes: RENEWAL_SUSPENDED_ALLOWED_PATH_PREFIXES,
        blocked_path_prefixes: RENEWAL_SUSPENDED_BLOCKED_PATH_PREFIXES,
        reason: "renewal_suspended",
      },
    };
  }

  if (isGrace) {
    return {
      subscription_status: RENEWAL_SUBSCRIPTION_STATUS.GRACE_PERIOD,
      access_status: RENEWAL_ACCESS_STATUS.GRACE,
      operational_blocked: false,
      access_restrictions: {
        operational_blocked: false,
        allowed_path_prefixes: [],
        blocked_path_prefixes: [],
        reason: "renewal_grace",
      },
    };
  }

  return {
    subscription_status: renewalSubStatus || access?.subscription_status || null,
    access_status: RENEWAL_ACCESS_STATUS.FULL,
    operational_blocked: false,
    access_restrictions: {
      operational_blocked: false,
      allowed_path_prefixes: [],
      blocked_path_prefixes: [],
      reason: null,
    },
  };
}
