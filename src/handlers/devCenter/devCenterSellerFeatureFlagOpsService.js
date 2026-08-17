import {
  DEV_CENTER_FEATURE_FLAG_CATALOG,
  isDevCenterFeatureFlagCatalogKey,
} from "./devCenterFeatureFlagCatalog.js";
import {
  DEV_CENTER_TOOLBOX_DEFAULTS,
  DEV_CENTER_TOOLBOX_FEATURE_FLAG_ACTION_IDS,
  DEV_CENTER_TOOLBOX_METADATA_KEYS,
  isDevCenterToolboxFeatureFlagActionId,
} from "./devCenterToolboxOperationalConstants.js";
import { registrarAuditoriaOperacionalToolbox } from "./devCenterToolboxOperationalAuditService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function listarFeatureFlagsSellerDevCenter(supabase, sellerId) {
  const { data, error } = await supabase
    .from("dev_center_seller_feature_flags")
    .select("flag_key, enabled, scope, marketplace, plan_id, metadata, updated_at, created_at")
    .eq("seller_id", sellerId);

  if (error && String(error.code ?? "") !== "42P01") throw error;

  /** @type {Map<string, Record<string, unknown>>} */
  const overrides = new Map();
  for (const row of data ?? []) {
    overrides.set(String(row.flag_key), row);
  }

  return Object.values(DEV_CENTER_FEATURE_FLAG_CATALOG).map((catalog) => {
    const row = overrides.get(catalog.key);
    const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
    return {
      key: catalog.key,
      label: catalog.label,
      description: catalog.description,
      category: catalog.category,
      source: row?.scope === "plan" ? "plan" : catalog.source,
      enabled: row?.enabled != null ? Boolean(row.enabled) : catalog.default_enabled,
      scope: row?.scope ?? "seller",
      marketplace: row?.marketplace ?? null,
      plan_id: row?.plan_id ?? null,
      created_at: row?.created_at ?? null,
      updated_at: row?.updated_at ?? null,
      cache_invalidated_at: meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.FEATURE_FLAG_CACHE_INVALIDATED_AT] ?? null,
    };
  });
}

/**
 * @param {string} reason
 */
function shouldSimulateDevFailure(reason) {
  return (
    process.env.NODE_ENV !== "production" &&
    String(reason ?? "").includes("[DEV:FORCE_ERROR]")
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{
 *   actionId: string;
 *   reason: string;
 *   operatorUserId: string;
 *   operatorEmail?: string | null;
 *   metadata?: Record<string, unknown> | null;
 * }} input
 */
export async function executarOperacaoFeatureFlagSellerDevCenter(supabase, sellerId, input) {
  const actionId = String(input.actionId ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const flagKey = String(metadata.flagKey ?? metadata.flag_key ?? "").trim();

  if (!isDevCenterToolboxFeatureFlagActionId(actionId)) {
    return { ok: false, status: "error", error: { code: "INVALID_ACTION", message: "Operação de feature flag inválida." } };
  }

  if (reason.length < DEV_CENTER_TOOLBOX_DEFAULTS.REASON_MIN_LENGTH) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "INVALID_REASON",
        message: `Motivo operacional deve ter ao menos ${DEV_CENTER_TOOLBOX_DEFAULTS.REASON_MIN_LENGTH} caracteres.`,
      },
    };
  }

  if (!isDevCenterFeatureFlagCatalogKey(flagKey)) {
    return {
      ok: false,
      status: "blocked",
      error: { code: "INVALID_FLAG_KEY", message: "Feature flag desconhecida ou não catalogada." },
    };
  }

  if (shouldSimulateDevFailure(reason)) {
    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { flagKey, dev_force_error: true },
      status: "error",
      errorCode: "DEV_FORCE_ERROR",
    });
    return {
      ok: false,
      status: "error",
      error: { code: "DEV_FORCE_ERROR", message: "Falha simulada via [DEV:FORCE_ERROR]." },
      auditId: audit?.id ?? null,
    };
  }

  const catalog = DEV_CENTER_FEATURE_FLAG_CATALOG[flagKey];
  const nextEnabled = actionId === "enable_feature_flag";
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from("dev_center_seller_feature_flags")
    .select("id, enabled")
    .eq("seller_id", sellerId)
    .eq("flag_key", flagKey)
    .maybeSingle();

  const previousEnabled = existing?.enabled ?? catalog.default_enabled;

  const beforeState = {
    flagKey,
    flagLabel: metadata.flagLabel ?? catalog.label,
    enabled: previousEnabled,
  };

  if (actionId === "enable_feature_flag" && existing?.enabled === true) {
    return {
      ok: false,
      status: "blocked",
      error: { code: "ALREADY_ENABLED", message: "Feature flag já está ativa para este seller." },
    };
  }

  if (actionId === "disable_feature_flag" && existing && existing.enabled === false) {
    return {
      ok: false,
      status: "blocked",
      error: { code: "ALREADY_DISABLED", message: "Feature flag já está inativa para este seller." },
    };
  }

  const row = {
    seller_id: sellerId,
    flag_key: flagKey,
    enabled: nextEnabled,
    scope: "seller",
    marketplace: metadata.marketplace != null ? String(metadata.marketplace) : null,
    plan_id: null,
    metadata: {
      flag_label: metadata.flagLabel ?? catalog.label,
      [DEV_CENTER_TOOLBOX_METADATA_KEYS.FEATURE_FLAG_CACHE_INVALIDATED_AT]: now,
      admin_operator_id: input.operatorUserId,
    },
    updated_by: input.operatorUserId,
    updated_at: now,
  };

  const { error: upsertErr } = await supabase
    .from("dev_center_seller_feature_flags")
    .upsert(row, { onConflict: "seller_id,flag_key" });

  if (upsertErr) {
    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { flagKey, actionId },
      status: "error",
      errorCode: "PERSISTENCE_FAILED",
    });
    return {
      ok: false,
      status: "error",
      error: { code: "PERSISTENCE_FAILED", message: upsertErr.message },
      auditId: audit?.id ?? null,
    };
  }

  const result = {
    flagKey,
    flagLabel: metadata.flagLabel ?? catalog.label,
    enabled: nextEnabled,
    updatedAt: now,
    cacheInvalidatedAt: now,
    previousEnabled,
  };

  const afterState = {
    flagKey,
    flagLabel: result.flagLabel,
    enabled: nextEnabled,
    updatedAt: now,
  };

  const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
    sellerId,
    operatorUserId: input.operatorUserId,
    operatorEmail: input.operatorEmail ?? null,
    operationType: actionId,
    reason,
    payload: { actionId, result, operator_metadata: metadata },
    beforeState,
    afterState,
    entityType: "feature_flag",
    entityId: flagKey,
    status: "success",
  });

  if (!audit?.id) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUDIT_PERSISTENCE_FAILED", message: "Auditoria operacional não registrada." },
      result,
    };
  }

  return {
    ok: true,
    status: "success",
    operationId: actionId,
    result,
    auditId: audit.id,
  };
}
