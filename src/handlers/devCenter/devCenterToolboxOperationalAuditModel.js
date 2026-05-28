// =============================================================================
// Dev Center Toolbox — modelo de auditoria estruturada (S1 Bloco 4)
// =============================================================================

/** @typedef {"subscription" | "feature_flag" | "integration" | "cache" | "sync" | "general"} DevCenterToolboxAuditCategory */

/** @typedef {"subscription" | "feature_flag" | "marketplace_account" | "seller" | "general"} DevCenterToolboxAuditEntityType */

/** @typedef {"normal" | "warning" | "critical"} DevCenterToolboxTimelineSeverity */

/** @type {Record<string, DevCenterToolboxAuditCategory>} */
export const DEV_CENTER_TOOLBOX_OPERATION_CATEGORY = Object.freeze({
  enable_trial: "subscription",
  end_trial: "subscription",
  add_subscription_days: "subscription",
  add_subscription_sales: "subscription",
  reset_consumption: "subscription",
  recalculate_consumption: "subscription",
  enable_feature_flag: "feature_flag",
  disable_feature_flag: "feature_flag",
  force_marketplace_sync: "integration",
  validate_marketplace_token: "integration",
  reimport_marketplace_account: "integration",
  invalidate_integration_cache: "cache",
  refresh_integration_health: "integration",
});

/** @type {Record<string, string>} */
export const DEV_CENTER_TOOLBOX_OPERATION_LABELS = Object.freeze({
  enable_trial: "Trial liberado",
  end_trial: "Trial encerrado",
  add_subscription_days: "Dias extras adicionados",
  add_subscription_sales: "Vendas extras adicionadas",
  reset_consumption: "Consumo resetado",
  recalculate_consumption: "Consumo recalculado",
  enable_feature_flag: "Feature flag ativada",
  disable_feature_flag: "Feature flag desativada",
  force_marketplace_sync: "Sync forçado de conta marketplace",
  validate_marketplace_token: "Token marketplace revalidado",
  reimport_marketplace_account: "Conta marketplace reimportada",
  invalidate_integration_cache: "Cache operacional invalidado",
  refresh_integration_health: "Saúde da integração atualizada",
});

/** @type {Set<string>} */
const CRITICAL_OPERATION_TYPES = new Set([
  "reimport_marketplace_account",
  "invalidate_integration_cache",
  "reset_consumption",
]);

/**
 * @param {string | null | undefined} operationType
 */
export function resolveToolboxOperationCategory(operationType) {
  return DEV_CENTER_TOOLBOX_OPERATION_CATEGORY[String(operationType ?? "").trim()] ?? "general";
}

/**
 * @param {string | null | undefined} operationType
 */
export function resolveToolboxOperationLabel(operationType) {
  const key = String(operationType ?? "").trim();
  return DEV_CENTER_TOOLBOX_OPERATION_LABELS[key] ?? (key || "Operação administrativa");
}

/**
 * @param {Record<string, unknown> | null | undefined} before
 * @param {Record<string, unknown> | null | undefined} after
 * @returns {string[]}
 */
export function computeChangedFields(before, after) {
  const keys = new Set([
    ...Object.keys(before && typeof before === "object" ? before : {}),
    ...Object.keys(after && typeof after === "object" ? after : {}),
  ]);

  /** @type {string[]} */
  const changed = [];
  for (const key of keys) {
    const b = before?.[key];
    const a = after?.[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) changed.push(key);
  }
  return changed.sort();
}

/**
 * @param {Record<string, unknown> | null | undefined} snapshot
 */
export function sanitizeOperationalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  /** @type {Record<string, unknown>} */
  const safe = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[key] = value.slice(0, 20);
    } else if (typeof value === "object") {
      safe[key] = sanitizeOperationalSnapshot(/** @type {Record<string, unknown>} */ (value));
    }
  }
  return safe;
}

/**
 * @param {{
 *   operationType: string;
 *   beforeState?: Record<string, unknown> | null;
 *   afterState?: Record<string, unknown> | null;
 *   entityType?: DevCenterToolboxAuditEntityType | string | null;
 *   entityId?: string | null;
 *   category?: DevCenterToolboxAuditCategory | string | null;
 *   marketplaceAccountId?: string | null;
 *   subscriptionId?: string | null;
 * }} input
 */
export function buildToolboxOperationalAuditContext(input) {
  const operationType = String(input.operationType ?? "").trim();
  const beforeState = sanitizeOperationalSnapshot(input.beforeState);
  const afterState = sanitizeOperationalSnapshot(input.afterState);
  const changedFields = computeChangedFields(beforeState, afterState);

  let entityType = input.entityType != null ? String(input.entityType).trim() : "";
  let entityId = input.entityId != null ? String(input.entityId).trim() : "";
  const category = input.category != null ? String(input.category).trim() : resolveToolboxOperationCategory(operationType);

  if (!entityType) {
    if (category === "subscription" && input.subscriptionId) {
      entityType = "subscription";
      entityId = String(input.subscriptionId);
    } else if (category === "feature_flag" && afterState.flagKey) {
      entityType = "feature_flag";
      entityId = String(afterState.flagKey);
    } else if (input.marketplaceAccountId) {
      entityType = "marketplace_account";
      entityId = String(input.marketplaceAccountId);
    } else {
      entityType = "general";
      entityId = entityId || operationType;
    }
  }

  return {
    category,
    entityType,
    entityId,
    beforeState,
    afterState,
    changedFields,
  };
}

/**
 * @param {"success" | "error" | "blocked"} status
 * @param {string | null | undefined} operationType
 * @returns {DevCenterToolboxTimelineSeverity}
 */
export function mapAuditStatusToTimelineSeverity(status, operationType) {
  if (status === "error" || status === "blocked") return "critical";
  if (CRITICAL_OPERATION_TYPES.has(String(operationType ?? ""))) return "warning";
  return "normal";
}

/**
 * @param {string | null | undefined} email
 */
export function deriveAdminDisplayNameFromEmail(email) {
  const local = String(email ?? "")
    .trim()
    .split("@")[0];
  if (!local) return "Admin";
  return local.charAt(0).toUpperCase() + local.slice(1);
}
