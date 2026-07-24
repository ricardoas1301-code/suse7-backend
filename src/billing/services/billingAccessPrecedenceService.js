// ======================================================================
// Precedência canônica de acesso (S1.HF.6.9A.10)
// Node SSOT — espelhada em billing_internal_resolve_access_precedence (SQL)
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ACCESS_RESTRICTION_REASON,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_HARD_PAUSE_OWNER,
  BILLING_SYNC_STATE,
} from "../billingConstants.js";

const TRIAL_LIFECYCLE_ENGINE = "TRIAL_LIFECYCLE_ENGINE";

/**
 * @param {unknown} value
 */
function asBool(value) {
  if (value === true || value === 1) return true;
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "t" || s === "1";
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function resolveCanonicalAccessPrecedence(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const accessProfile = String(meta.access_profile ?? BILLING_ACCESS_PROFILE.FULL_ACCESS);
  const syncState = String(meta.sync_state ?? BILLING_SYNC_STATE.FULL);
  const hardPauseOwner = String(meta.hard_pause_owner ?? "");
  const restrictionReason = String(meta.access_restriction_reason ?? "").trim();

  if (
    asBool(meta.security_access_revoked) ||
    asBool(meta.integration_access_revoked) ||
    asBool(meta.tenant_disabled) ||
    restrictionReason === "SECURITY_REVOKED" ||
    restrictionReason === "INTEGRATION_REVOKED" ||
    restrictionReason === "TENANT_DISABLED"
  ) {
    return {
      precedence_rank: 1,
      reason: "security_or_revocation",
      allow_process_sale: false,
      allow_quota_bypass_trial: false,
      access_profile: accessProfile,
      sync_state: syncState,
      hard_pause_owner: hardPauseOwner || null,
      webhook_ok: true,
    };
  }

  if (accessProfile === BILLING_ACCESS_PROFILE.FINANCIAL_RECOVERY_ONLY) {
    return {
      precedence_rank: 2,
      reason: "financial_recovery_only",
      allow_process_sale: false,
      allow_quota_bypass_trial: false,
      access_profile: accessProfile,
      sync_state: syncState,
      hard_pause_owner: hardPauseOwner || null,
      webhook_ok: true,
    };
  }

  if (
    asBool(meta.administrative_hold) ||
    asBool(meta.data_integrity_hold) ||
    restrictionReason === "ADMINISTRATIVE_HOLD" ||
    restrictionReason === "DATA_INTEGRITY_HOLD"
  ) {
    return {
      precedence_rank: 3,
      reason: "administrative_or_integrity_hold",
      allow_process_sale: false,
      allow_quota_bypass_trial: false,
      access_profile: accessProfile,
      sync_state: syncState,
      hard_pause_owner: hardPauseOwner || null,
      webhook_ok: true,
    };
  }

  if (
    syncState === BILLING_SYNC_STATE.HARD_PAUSED &&
    (hardPauseOwner === BILLING_HARD_PAUSE_OWNER.BABY_QUOTA_ENGINE ||
      hardPauseOwner === "" /* legado pré-owner: trata como Baby se reason clássico */)
  ) {
    const reason = String(meta.hard_pause_reason ?? "");
    const isBabyQuota =
      hardPauseOwner === BILLING_HARD_PAUSE_OWNER.BABY_QUOTA_ENGINE ||
      reason === "BABY_LIMIT_REACHED";
    if (isBabyQuota) {
      return {
        precedence_rank: 4,
        reason: "baby_quota_hard_paused",
        allow_process_sale: false,
        allow_quota_bypass_trial: false,
        access_profile: accessProfile,
        sync_state: syncState,
        hard_pause_owner: BILLING_HARD_PAUSE_OWNER.BABY_QUOTA_ENGINE,
        domain_code: "BABY_HARD_LIMIT_REACHED",
        webhook_ok: true,
      };
    }
  }

  // Pós-trial — owner TRIAL_LIFECYCLE_ENGINE (S1.HF.6.9A.11).
  // Sync/webhooks/import permanecem ativos; só capabilities de UI restringem.
  if (
    restrictionReason === BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED ||
    String(meta.access_owner ?? "") === TRIAL_LIFECYCLE_ENGINE ||
    String(meta.effective_entitlement ?? "") ===
      BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED
  ) {
    return {
      precedence_rank: 5,
      reason: "trial_expired_restricted",
      allow_process_sale: true,
      allow_quota_bypass_trial: false,
      access_profile: BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      sync_state: BILLING_SYNC_STATE.FULL,
      hard_pause_owner: hardPauseOwner || null,
      access_owner: TRIAL_LIFECYCLE_ENGINE,
      webhook_ok: true,
    };
  }

  if (
    accessProfile === BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY ||
    accessProfile === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY ||
    String(meta.usage_state ?? "") === "LIMIT_REACHED" ||
    String(meta.usage_state ?? "") === "LIMIT_RESTRICTED"
  ) {
    const isPaidRestricted =
      String(meta.effective_entitlement ?? "") === "PAID_PLAN" ||
      (!asBool(meta.suspension_fallback_active) &&
        String(meta.effective_entitlement ?? "") !== "BABY_INTERNAL_FREE" &&
        String(meta.effective_entitlement ?? "") !== "TRIAL_FULL_ACCESS" &&
        String(meta.effective_entitlement ?? "") !==
          BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED);
    if (isPaidRestricted && syncState !== BILLING_SYNC_STATE.HARD_PAUSED) {
      return {
        precedence_rank: 5,
        reason: "paid_usage_restricted",
        allow_process_sale: false,
        allow_quota_bypass_trial: false,
        access_profile: accessProfile,
        sync_state: syncState,
        hard_pause_owner: hardPauseOwner || null,
        webhook_ok: true,
      };
    }
  }

  return {
    precedence_rank: 6,
    reason: "trial_or_full_normal",
    allow_process_sale: true,
    allow_quota_bypass_trial: true,
    access_profile: accessProfile,
    sync_state: syncState,
    hard_pause_owner: hardPauseOwner || null,
    webhook_ok: true,
  };
}

/**
 * Aplica resultado de precedência após limpar somente condição BABY_QUOTA.
 *
 * @param {Record<string, unknown>} metadata
 * @param {{ clear_baby_quota_pause?: boolean }} [options]
 */
export function applyAccessPrecedenceToMetadata(metadata, options = {}) {
  let meta = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  if (options.clear_baby_quota_pause) {
    if (String(meta.hard_pause_owner ?? "") === BILLING_HARD_PAUSE_OWNER.BABY_QUOTA_ENGINE) {
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
      if (String(meta.access_profile ?? "") === BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY) {
        meta.access_profile = BILLING_ACCESS_PROFILE.FULL_ACCESS;
      }
      if (String(meta.usage_state ?? "") === "LIMIT_REACHED") {
        meta.usage_state = "WITHIN_LIMIT";
      }
    }
  }
  const resolved = resolveCanonicalAccessPrecedence(meta);
  // Não sobrescrever restrições superiores — só materializa sync/profile se rank 6
  if (resolved.precedence_rank === 6) {
    meta = {
      ...meta,
      sync_state: meta.sync_state ?? BILLING_SYNC_STATE.FULL,
      access_profile: meta.access_profile ?? BILLING_ACCESS_PROFILE.FULL_ACCESS,
    };
  }
  return { metadata: meta, precedence: resolved };
}
