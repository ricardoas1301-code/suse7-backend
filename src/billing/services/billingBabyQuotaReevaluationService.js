// ======================================================================
// Reavaliação do BABY_QUOTA_ENGINE após mudança de entitlement (S1.HF.6.9A.12A)
// Financial Engine NÃO apaga Baby por conveniência — motor proprietário reavalia.
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_HARD_PAUSE_OWNER,
  BILLING_SYNC_STATE,
  BILLING_SUSPENSION_FALLBACK_METADATA_KEYS,
} from "../billingConstants.js";
import { resolveCanonicalAccessPrecedence } from "./billingAccessPrecedenceService.js";

export const BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE = "BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE";

/**
 * @param {Record<string, unknown>} metadata
 */
function babyEntitlementStillApplicable(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  if (meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVE] === true) return true;
  const entitlement = String(meta.effective_entitlement ?? meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ENTITLEMENT] ?? "");
  const source = String(
    meta.entitlement_source ??
      meta.effective_entitlement_source ??
      meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.SOURCE] ??
      "",
  );
  if (entitlement === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE) return true;
  if (
    source === BILLING_ENTITLEMENT_SOURCE.BABY_FALLBACK ||
    source === BILLING_ENTITLEMENT_SOURCE.SUSPENSION_FALLBACK
  ) {
    return true;
  }
  return false;
}

/**
 * Reavalia restrição Baby após entitlement deixar de ser Baby/fallback.
 * Preserva histórico de consumo Baby; não funde com consumo pago; não força FULL_ACCESS.
 *
 * @param {Record<string, unknown> | null | undefined} metadata
 * @param {{
 *   effective_entitlement?: string | null;
 *   entitlement_source?: string | null;
 *   now?: Date;
 * }} [context]
 */
export function reevaluateBabyQuotaAfterEntitlementChange(metadata, context = {}) {
  const meta = {
    ...(metadata && typeof metadata === "object" ? metadata : {}),
  };

  if (context.effective_entitlement != null) {
    meta.effective_entitlement = context.effective_entitlement;
  }
  if (context.entitlement_source != null) {
    meta.entitlement_source = context.entitlement_source;
    meta.effective_entitlement_source = context.entitlement_source;
  }

  if (babyEntitlementStillApplicable(meta)) {
    return {
      metadata: meta,
      changed: false,
      result: "BABY_STILL_APPLICABLE",
      clear_baby_quota_owner: false,
      precedence: resolveCanonicalAccessPrecedence(meta),
    };
  }

  const hadBabyOwner = String(meta.hard_pause_owner ?? "") === BILLING_HARD_PAUSE_OWNER.BABY_QUOTA_ENGINE;
  if (!hadBabyOwner) {
    return {
      metadata: meta,
      changed: false,
      result: "NO_BABY_QUOTA_OWNER",
      clear_baby_quota_owner: false,
      precedence: resolveCanonicalAccessPrecedence(meta),
    };
  }

  // Snapshot histórico do consumo Baby (não fundir com pago).
  if (meta.usage_billed_count != null || meta.quota_counting_started_at != null) {
    meta.baby_usage_history = {
      ...(typeof meta.baby_usage_history === "object" && meta.baby_usage_history
        ? /** @type {Record<string, unknown>} */ (meta.baby_usage_history)
        : {}),
      billed_count_at_exit: meta.usage_billed_count ?? null,
      quota_counting_started_at: meta.quota_counting_started_at ?? null,
      closed_at: (context.now instanceof Date ? context.now : new Date()).toISOString(),
      reason: BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE,
    };
  }

  delete meta.hard_pause_started_at;
  delete meta.hard_pause_cycle_key;
  delete meta.hard_pause_admission_id;
  delete meta.hard_pause_reason;
  delete meta.hard_pause_entitlement_source;
  delete meta.hard_pause_owner;
  delete meta.hard_pause_source;
  delete meta.pause_started_at;
  delete meta.data_gap_start;

  if (String(meta.sync_state ?? "") === BILLING_SYNC_STATE.HARD_PAUSED) {
    meta.sync_state = BILLING_SYNC_STATE.FULL;
  }

  // Não forçar FULL_ACCESS — precedência decide (security/recovery/consumo pago).
  if (
    String(meta.access_profile ?? "") === BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY &&
    String(meta.access_restriction_reason ?? "") !== "SECURITY_REVOKED" &&
    String(meta.access_restriction_reason ?? "") !== "INTEGRATION_REVOKED" &&
    meta.security_access_revoked !== true
  ) {
    // Perfil órfão do Baby: remove ARCHIVE só se não houver outro motivo explícito.
    delete meta.access_profile;
  }

  meta.baby_quota_reevaluation = BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE;
  meta.baby_quota_reevaluated_at = (context.now instanceof Date ? context.now : new Date()).toISOString();

  const precedence = resolveCanonicalAccessPrecedence(meta);
  return {
    metadata: meta,
    changed: true,
    result: BABY_QUOTA_RESTRICTION_NO_LONGER_APPLICABLE,
    clear_baby_quota_owner: true,
    precedence,
  };
}
