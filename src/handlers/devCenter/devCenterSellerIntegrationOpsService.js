import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";
import {
  createMlInitialSyncJobsIfAbsent,
  ML_FORCE_RESET_JOB_TYPES,
} from "../../services/marketplace/createMlInitialSyncJobs.js";
import {
  buildMlConnectionUiPack,
  fetchMlTokenProbeForMlSeller,
  fetchMlTokenProbeForUser,
} from "../../services/marketplace/marketplaceAccountConnectionHealth.js";
import {
  DEV_CENTER_TOOLBOX_DEFAULTS,
  DEV_CENTER_TOOLBOX_METADATA_KEYS,
  isDevCenterToolboxIntegrationActionId,
} from "./devCenterToolboxOperationalConstants.js";
import { registrarAuditoriaOperacionalToolbox } from "./devCenterToolboxOperationalAuditService.js";

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
function readAccountMeta(row) {
  return row?.metadata && typeof row.metadata === "object"
    ? /** @type {Record<string, unknown>} */ ({ ...row.metadata })
    : {};
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} accountId
 */
async function loadMarketplaceAccountForSeller(supabase, sellerId, accountId) {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select(
      "id, user_id, marketplace, status, seller_company_id, external_seller_id, ml_nickname, account_alias, token_expires_at, ml_sales_last_sync_at, updated_at",
    )
    .eq("id", accountId)
    .eq("user_id", sellerId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} account
 */
async function probeAccountToken(supabase, account) {
  const sellerId = String(account.user_id);
  const marketplace = String(account.marketplace ?? ML_MARKETPLACE_SLUG);
  const ext = account.external_seller_id != null ? String(account.external_seller_id).trim() : "";
  const accountId = String(account.id);

  return ext
    ? await fetchMlTokenProbeForMlSeller(supabase, sellerId, marketplace, ext, accountId)
    : await fetchMlTokenProbeForUser(supabase, sellerId, marketplace);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} accountId
 * @param {boolean} force
 */
async function resetActiveSyncJobs(supabase, accountId, force) {
  if (!force) return;
  await supabase
    .from("marketplace_account_sync_jobs")
    .update({
      status: "pending",
      started_at: null,
      finished_at: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("marketplace_account_id", accountId)
    .in("job_type", ML_FORCE_RESET_JOB_TYPES);
}

/**
 * Persistência operacional admin em metadata da conta quando a coluna existir.
 * Falha silenciosa mantém resultado/auditoria como source of truth.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} account
 * @param {Record<string, unknown>} metaPatch
 */
async function patchAccountMetadata(supabase, account, metaPatch) {
  const meta = { ...readAccountMeta(account), ...metaPatch };
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .update({ metadata: meta, updated_at: new Date().toISOString() })
    .eq("id", account.id)
    .select(
      "id, user_id, marketplace, status, seller_company_id, external_seller_id, ml_nickname, account_alias, token_expires_at, ml_sales_last_sync_at, updated_at",
    )
    .maybeSingle();

  if (error) {
    const msg = String(error.message ?? "");
    if (msg.includes("metadata") && (msg.includes("does not exist") || msg.includes("column"))) {
      return account;
    }
    throw error;
  }

  return data ?? account;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} account
 */
async function buildAccountHealthSnapshot(supabase, account) {
  const tokenProbe = await probeAccountToken(supabase, account);
  const pack = buildMlConnectionUiPack(account, tokenProbe, false);
  return {
    connection_health: pack.connection_health,
    connection_badge_label: pack.connection_badge_label,
    token_expires_at: account.token_expires_at ?? tokenProbe.expires_at ?? null,
    token_present: Boolean(tokenProbe.present),
    token_account_mismatch: Boolean(tokenProbe.token_account_mismatch),
    last_sync_at: account.ml_sales_last_sync_at ?? null,
  };
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
export async function executarOperacaoIntegracaoSellerDevCenter(supabase, sellerId, input) {
  const actionId = String(input.actionId ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const accountId = String(metadata.accountId ?? metadata.marketplace_account_id ?? "").trim();

  if (!isDevCenterToolboxIntegrationActionId(actionId)) {
    return { ok: false, status: "error", error: { code: "INVALID_ACTION", message: "Operação de integração inválida." } };
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

  if (!accountId) {
    return {
      ok: false,
      status: "blocked",
      error: { code: "ACCOUNT_ID_REQUIRED", message: "marketplace_account_id é obrigatório." },
    };
  }

  if (shouldSimulateDevFailure(reason)) {
    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      marketplaceAccountId: accountId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { accountId, dev_force_error: true },
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

  const account = await loadMarketplaceAccountForSeller(supabase, sellerId, accountId);
  if (!account?.id) {
    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      marketplaceAccountId: accountId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { accountId, blocked: true },
      status: "blocked",
      errorCode: "ACCOUNT_NOT_FOUND",
    });
    return {
      ok: false,
      status: "blocked",
      error: { code: "ACCOUNT_NOT_FOUND", message: "Conta marketplace não encontrada para este seller." },
      auditId: audit?.id ?? null,
    };
  }

  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  let result = { accountId, marketplace: account.marketplace ?? null };

  const beforeState = {
    accountId,
    marketplace: account.marketplace ?? null,
    status: account.status ?? null,
    last_sync_at: account.ml_sales_last_sync_at ?? null,
    token_expires_at: account.token_expires_at ?? null,
  };

  try {
    switch (actionId) {
      case "validate_marketplace_token": {
        const health = await buildAccountHealthSnapshot(supabase, account);
        await patchAccountMetadata(supabase, account, {
          admin_token_validated_at: now,
          admin_token_validation: health,
        });
        result = {
          ...result,
          ...health,
          newTokenStatus: health.connection_health,
          validatedAt: now,
        };
        break;
      }
      case "force_marketplace_sync": {
        await resetActiveSyncJobs(supabase, accountId, true);
        const enqueue = await createMlInitialSyncJobsIfAbsent(supabase, {
          userId: sellerId,
          marketplaceAccountId: accountId,
          sellerCompanyId: account.seller_company_id != null ? String(account.seller_company_id) : null,
          marketplace: String(account.marketplace ?? ML_MARKETPLACE_SLUG),
        });
        await patchAccountMetadata(supabase, account, {
          admin_sync_requested_at: now,
          admin_last_sync_operation: "force_marketplace_sync",
        });
        result = {
          ...result,
          jobsCreated: enqueue.created,
          skipped: enqueue.skipped,
          newSyncStatus: enqueue.skipped ? "running_or_pending" : "queued",
          syncedAt: now,
        };
        break;
      }
      case "reimport_marketplace_account": {
        await resetActiveSyncJobs(supabase, accountId, true);
        const enqueue = await createMlInitialSyncJobsIfAbsent(supabase, {
          userId: sellerId,
          marketplaceAccountId: accountId,
          sellerCompanyId: account.seller_company_id != null ? String(account.seller_company_id) : null,
          marketplace: String(account.marketplace ?? ML_MARKETPLACE_SLUG),
        });
        await patchAccountMetadata(supabase, account, {
          admin_reimport_requested_at: now,
          admin_last_sync_operation: "reimport_marketplace_account",
        });
        result = {
          ...result,
          reimported: true,
          jobsCreated: enqueue.created,
          skipped: enqueue.skipped,
          syncedAt: now,
        };
        break;
      }
      case "invalidate_integration_cache": {
        await patchAccountMetadata(supabase, account, {
          [DEV_CENTER_TOOLBOX_METADATA_KEYS.INTEGRATION_CACHE_INVALIDATED_AT]: now,
        });
        result = {
          ...result,
          cacheInvalidatedAt: now,
          invalidatedScopes: ["integrations", "toolbox", "resumo_seller"],
        };
        break;
      }
      case "refresh_integration_health": {
        const health = await buildAccountHealthSnapshot(supabase, account);
        await patchAccountMetadata(supabase, account, {
          [DEV_CENTER_TOOLBOX_METADATA_KEYS.INTEGRATION_HEALTH_REFRESHED_AT]: now,
          admin_connection_health_snapshot: health,
        });
        result = {
          ...result,
          ...health,
          refreshedAt: now,
        };
        break;
      }
      default:
        return {
          ok: false,
          status: "error",
          error: { code: "INVALID_ACTION", message: "Operação não suportada." },
        };
    }

    const afterState = {
      ...beforeState,
      connection_health: result.connection_health ?? beforeState.connection_health ?? null,
      newTokenStatus: result.newTokenStatus ?? null,
      newSyncStatus: result.newSyncStatus ?? null,
      cacheInvalidatedAt: result.cacheInvalidatedAt ?? null,
      reimported: result.reimported ?? null,
      refreshedAt: result.refreshedAt ?? null,
    };

    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      marketplaceAccountId: accountId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { actionId, result, operator_metadata: metadata },
      beforeState,
      afterState,
      entityType: "marketplace_account",
      entityId: accountId,
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
      marketplaceAccountId: accountId,
      result,
      auditId: audit.id,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Erro ao executar operação de integração.";
    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      marketplaceAccountId: accountId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { actionId, accountId },
      status: "error",
      errorCode: "PERSISTENCE_FAILED",
    });
    return {
      ok: false,
      status: "error",
      error: { code: "PERSISTENCE_FAILED", message },
      auditId: audit?.id ?? null,
    };
  }
}
