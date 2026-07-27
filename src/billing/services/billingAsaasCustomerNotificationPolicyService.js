// ======================================================================
// Política de notificações Asaas — confirmação, cache, fail-closed, ownership
// S1.HF.ASAAS-NOTIFICATIONS.1
// ======================================================================

import { createHash } from "node:crypto";
import { logBilling, logBillingError } from "../billingLog.js";
import {
  assertBillingFinancialMutationsAllowed,
  BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
  resolveS7RuntimeEnvironment,
} from "./billingRuntimeEnvironmentService.js";
import {
  ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED,
  CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION,
  DEFAULT_NOTIFICATION_POLICY_TTL_MS,
  POLICY_STATUS,
} from "../providers/customerCommunicationPolicyConstants.js";
import { AsaasCustomerCommunicationPolicyStrategy } from "../providers/asaas/asaasCustomerCommunicationPolicyStrategy.js";
import { applyAsaasCustomerNotificationPolicy } from "../providers/asaas/applyAsaasCustomerNotificationPolicy.js";

export { ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED };

/** @type {Map<string, { status: string; confirmedAt: number; policyVersion: string; environment: string }>} */
const confirmationCache = new Map();

/** @type {Map<string, Promise<unknown>>} */
const singleFlight = new Map();

/**
 * @param {string | null | undefined} customerId
 */
export function maskAsaasCustomerId(customerId) {
  const id = String(customerId ?? "").trim();
  if (!id) return null;
  if (id.length <= 8) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * @param {string | null | undefined} customerId
 */
export function hashAsaasCustomerId(customerId) {
  const id = String(customerId ?? "").trim();
  if (!id) return null;
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function policyTtlMs(env = process.env) {
  const raw = Number(env.ASAAS_NOTIFICATION_POLICY_TTL_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return Math.floor(raw);
  return DEFAULT_NOTIFICATION_POLICY_TTL_MS;
}

function cacheKey(environment, customerId) {
  return `${environment || "unknown"}:${String(customerId)}:${CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION}`;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
function emitPolicyEvent(event, fields = {}) {
  logBilling("asaas", event, {
    provider: "asaas",
    policy_version: CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION,
    ...fields,
  });
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function assertAsaasSandboxMutationsAllowed(env = process.env) {
  const gate = assertBillingFinancialMutationsAllowed(env);
  if (!gate.ok) {
    emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_BLOCKED_ENVIRONMENT", {
      reasons: gate.error?.reasons ?? [],
    });
    return gate;
  }
  const runtime = gate.runtime;
  if (runtime.asaasEnv !== "sandbox" && runtime.s7AppEnv !== "production") {
    // DEV/staging exigem sandbox; produção oficial só com S7_APP_ENV=production (fora desta missão)
    emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_BLOCKED_ENVIRONMENT", {
      reasons: ["ASAAS_ENV_MUST_BE_SANDBOX_FOR_NON_PROD_APP"],
    });
    return {
      ok: false,
      runtime,
      error: {
        ok: false,
        blocked: true,
        code: BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
        reasons: ["ASAAS_ENV_MUST_BE_SANDBOX_FOR_NON_PROD_APP"],
      },
    };
  }
  return gate;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ userId: string; providerCustomerId: string; provider?: string }} input
 */
export async function assertBillingCustomerOwnership(supabase, input) {
  const userId = String(input.userId || "").trim();
  const providerCustomerId = String(input.providerCustomerId || "").trim();
  const provider = String(input.provider || "asaas").trim().toLowerCase();

  if (!userId || !providerCustomerId) {
    return {
      ok: false,
      code: "OWNERSHIP_INPUT_INVALID",
      status: POLICY_STATUS.MANUAL_REVIEW,
    };
  }

  const { data, error } = await supabase
    .from("billing_customers")
    .select("id, user_id, provider, provider_customer_id")
    .eq("provider", provider)
    .eq("provider_customer_id", providerCustomerId)
    .maybeSingle();

  if (error) {
    return { ok: false, code: "OWNERSHIP_QUERY_FAILED", status: POLICY_STATUS.RETRYABLE_ERROR, error };
  }
  if (!data) {
    emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_BLOCKED_OWNERSHIP", {
      seller_id: userId,
      customer_id_masked: maskAsaasCustomerId(providerCustomerId),
      reason: "CUSTOMER_NOT_LINKED",
    });
    return { ok: false, code: "CUSTOMER_NOT_LINKED", status: POLICY_STATUS.MANUAL_REVIEW };
  }
  if (String(data.user_id) !== userId) {
    emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_BLOCKED_OWNERSHIP", {
      seller_id: userId,
      customer_id_masked: maskAsaasCustomerId(providerCustomerId),
      reason: "CUSTOMER_OWNED_BY_OTHER_SELLER",
    });
    return {
      ok: false,
      code: "CUSTOMER_OWNED_BY_OTHER_SELLER",
      status: POLICY_STATUS.MANUAL_REVIEW,
    };
  }
  return { ok: true, row: data, status: POLICY_STATUS.CONFIRMED_DISABLED };
}

/**
 * @param {string} environment
 * @param {string} providerCustomerId
 */
export function getCachedNotificationPolicyConfirmation(environment, providerCustomerId, env = process.env) {
  const key = cacheKey(environment, providerCustomerId);
  const hit = confirmationCache.get(key);
  if (!hit) return null;
  if (hit.policyVersion !== CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION) {
    confirmationCache.delete(key);
    return null;
  }
  if (hit.environment !== environment) {
    confirmationCache.delete(key);
    return null;
  }
  if (Date.now() - hit.confirmedAt > policyTtlMs(env)) {
    confirmationCache.delete(key);
    return null;
  }
  if (hit.status !== POLICY_STATUS.CONFIRMED_DISABLED) return null;
  return hit;
}

/**
 * @param {string} environment
 * @param {string} providerCustomerId
 * @param {string} status
 */
export function setCachedNotificationPolicyConfirmation(environment, providerCustomerId, status) {
  const key = cacheKey(environment, providerCustomerId);
  if (status !== POLICY_STATUS.CONFIRMED_DISABLED) {
    confirmationCache.delete(key);
    return;
  }
  confirmationCache.set(key, {
    status,
    confirmedAt: Date.now(),
    policyVersion: CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION,
    environment,
  });
}

/** @internal testes */
export function _resetNotificationPolicyCacheForTests() {
  confirmationCache.clear();
  singleFlight.clear();
}

/**
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} providerCustomerId
 */
export async function fetchRemoteCustomerNotificationState(providerApi, providerCustomerId) {
  if (typeof providerApi.getCustomer !== "function") {
    return { ok: false, code: "GET_CUSTOMER_UNSUPPORTED", remote: null };
  }
  const remote = await providerApi.getCustomer(providerCustomerId);
  const classified = AsaasCustomerCommunicationPolicyStrategy.classifyRemoteCustomer(
    remote && typeof remote === "object" ? /** @type {Record<string, unknown>} */ (remote) : null
  );
  return { ok: true, remote, ...classified };
}

/**
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} providerCustomerId
 */
export async function listRemoteCustomerNotifications(providerApi, providerCustomerId) {
  if (typeof providerApi.listCustomerNotifications !== "function") {
    return { ok: false, code: "LIST_NOTIFICATIONS_UNSUPPORTED", notifications: [] };
  }
  const body = await providerApi.listCustomerNotifications(providerCustomerId);
  const rows =
    body && typeof body === "object" && Array.isArray(/** @type {{ data?: unknown[] }} */ (body).data)
      ? /** @type {{ data: Record<string, unknown>[] }} */ (body).data
      : Array.isArray(body)
        ? body
        : [];
  return { ok: true, notifications: rows, raw: body };
}

/**
 * Protege customer existente: update + confirmação remota.
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {{
 *   providerCustomerId: string;
 *   userId?: string | null;
 *   taxId?: string | null;
 *   dryRun?: boolean;
 *   correlationId?: string | null;
 *   skipCache?: boolean;
 * }} input
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export async function ensureAsaasCustomerNotificationPolicy(providerApi, input, env = process.env) {
  const providerCustomerId = String(input.providerCustomerId || "").trim();
  const correlationId = input.correlationId ? String(input.correlationId) : null;
  const runtime = resolveS7RuntimeEnvironment(env);

  emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_EVALUATED", {
    customer_id_masked: maskAsaasCustomerId(providerCustomerId),
    customer_id_hash: hashAsaasCustomerId(providerCustomerId),
    seller_id: input.userId ?? null,
    correlation_id: correlationId,
    environment: runtime.asaasEnv,
  });

  if (!providerCustomerId) {
    return {
      ok: false,
      code: ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED,
      status: POLICY_STATUS.PERMANENT_ERROR,
      reason: "CUSTOMER_ID_ABSENT",
    };
  }

  const envGate = assertAsaasSandboxMutationsAllowed(env);
  if (!envGate.ok && !input.dryRun) {
    return {
      ok: false,
      code: BILLING_RUNTIME_ENVIRONMENT_UNCONFIRMED,
      status: POLICY_STATUS.PERMANENT_ERROR,
      reason: "ENVIRONMENT_BLOCKED",
      reasons: envGate.error?.reasons ?? [],
    };
  }

  const environment = String(runtime.asaasEnv || "unknown");
  if (!input.skipCache && !input.dryRun) {
    const cached = getCachedNotificationPolicyConfirmation(environment, providerCustomerId, env);
    if (cached) {
      emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_ALREADY_PROTECTED", {
        customer_id_masked: maskAsaasCustomerId(providerCustomerId),
        correlation_id: correlationId,
        source: "cache",
      });
      return {
        ok: true,
        status: POLICY_STATUS.CONFIRMED_DISABLED,
        fromCache: true,
        customerIdMasked: maskAsaasCustomerId(providerCustomerId),
      };
    }
  }

  const flightKey = cacheKey(environment, providerCustomerId);
  if (singleFlight.has(flightKey)) {
    return singleFlight.get(flightKey);
  }

  const work = (async () => {
    const started = Date.now();
    try {
      let before = null;
      if (typeof providerApi.getCustomer === "function") {
        try {
          before = await fetchRemoteCustomerNotificationState(providerApi, providerCustomerId);
          if (before.confirmed) {
            setCachedNotificationPolicyConfirmation(
              environment,
              providerCustomerId,
              POLICY_STATUS.CONFIRMED_DISABLED
            );
            emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_ALREADY_PROTECTED", {
              customer_id_masked: maskAsaasCustomerId(providerCustomerId),
              correlation_id: correlationId,
              source: "remote",
              duration_ms: Date.now() - started,
            });
            return {
              ok: true,
              status: POLICY_STATUS.CONFIRMED_DISABLED,
              before: { notificationDisabled: before.notificationDisabled },
              after: { notificationDisabled: true },
              fromCache: false,
              customerIdMasked: maskAsaasCustomerId(providerCustomerId),
            };
          }
        } catch (err) {
          emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_RETRY", {
            customer_id_masked: maskAsaasCustomerId(providerCustomerId),
            correlation_id: correlationId,
            phase: "get_before",
            error_code: err instanceof Error ? err.message : "GET_FAILED",
          });
        }
      }

      if (input.dryRun) {
        emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_DRY_RUN", {
          customer_id_masked: maskAsaasCustomerId(providerCustomerId),
          correlation_id: correlationId,
          before_notification_disabled: before?.notificationDisabled ?? null,
        });
        return {
          ok: true,
          dryRun: true,
          status: before?.confirmed ? POLICY_STATUS.CONFIRMED_DISABLED : POLICY_STATUS.PENDING_CONFIRMATION,
          before: { notificationDisabled: before?.notificationDisabled ?? null },
          customerIdMasked: maskAsaasCustomerId(providerCustomerId),
        };
      }

      if (typeof providerApi.updateCustomer !== "function") {
        return {
          ok: false,
          code: ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED,
          status: POLICY_STATUS.PERMANENT_ERROR,
          reason: "UPDATE_CUSTOMER_UNSUPPORTED",
        };
      }

      emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_UPDATE_REQUESTED", {
        customer_id_masked: maskAsaasCustomerId(providerCustomerId),
        correlation_id: correlationId,
      });

      const updatePayload = applyAsaasCustomerNotificationPolicy({
        ...(input.taxId ? { cpfCnpj: input.taxId } : {}),
      });
      await providerApi.updateCustomer(providerCustomerId, updatePayload);

      const after = await fetchRemoteCustomerNotificationState(providerApi, providerCustomerId);
      if (!after.ok || !after.confirmed) {
        emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_DIVERGENT", {
          customer_id_masked: maskAsaasCustomerId(providerCustomerId),
          correlation_id: correlationId,
          after_notification_disabled: after.notificationDisabled,
          duration_ms: Date.now() - started,
        });
        return {
          ok: false,
          code: ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED,
          status: POLICY_STATUS.DIVERGENT,
          before: { notificationDisabled: before?.notificationDisabled ?? null },
          after: { notificationDisabled: after.notificationDisabled },
          customerIdMasked: maskAsaasCustomerId(providerCustomerId),
        };
      }

      setCachedNotificationPolicyConfirmation(environment, providerCustomerId, POLICY_STATUS.CONFIRMED_DISABLED);
      emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_CONFIRMED", {
        customer_id_masked: maskAsaasCustomerId(providerCustomerId),
        correlation_id: correlationId,
        duration_ms: Date.now() - started,
      });
      emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_RECONCILED", {
        customer_id_masked: maskAsaasCustomerId(providerCustomerId),
        correlation_id: correlationId,
      });

      return {
        ok: true,
        status: POLICY_STATUS.CONFIRMED_DISABLED,
        before: { notificationDisabled: before?.notificationDisabled ?? null },
        after: { notificationDisabled: true },
        fromCache: false,
        customerIdMasked: maskAsaasCustomerId(providerCustomerId),
      };
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err ? Number(/** @type {{ status?: number }} */ (err).status) : null;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 408;
      emitPolicyEvent("ASAAS_NOTIFICATION_POLICY_FAILED", {
        customer_id_masked: maskAsaasCustomerId(providerCustomerId),
        correlation_id: correlationId,
        error_code: status != null ? `HTTP_${status}` : "UPDATE_FAILED",
        duration_ms: Date.now() - started,
      });
      logBillingError("asaas", "notification_policy_failed", err, {
        customer_id_masked: maskAsaasCustomerId(providerCustomerId),
      });
      return {
        ok: false,
        code: ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED,
        status: retryable ? POLICY_STATUS.RETRYABLE_ERROR : POLICY_STATUS.PERMANENT_ERROR,
        httpStatus: status,
        reason: err instanceof Error ? err.message : "UPDATE_FAILED",
        customerIdMasked: maskAsaasCustomerId(providerCustomerId),
      };
    } finally {
      singleFlight.delete(flightKey);
    }
  })();

  singleFlight.set(flightKey, work);
  return work;
}

/**
 * Fail-closed antes de cobrança/assinatura.
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {{ providerCustomerId: string; userId?: string | null; correlationId?: string | null }} input
 */
export async function assertCustomerNotificationPolicyForCharge(providerApi, input, env = process.env) {
  const result = await ensureAsaasCustomerNotificationPolicy(
    providerApi,
    {
      providerCustomerId: input.providerCustomerId,
      userId: input.userId,
      correlationId: input.correlationId,
      dryRun: false,
    },
    env
  );

  if (result.ok && result.status === POLICY_STATUS.CONFIRMED_DISABLED) {
    return { ok: true, result };
  }

  const err = new Error("Operação temporariamente indisponível. Tente novamente em instantes.");
  /** @type {any} */ (err).code = ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED;
  /** @type {any} */ (err).httpStatus = 503;
  /** @type {any} */ (err).retryable = result.status === POLICY_STATUS.RETRYABLE_ERROR;
  /** @type {any} */ (err).policyStatus = result.status;
  /** @type {any} */ (err).doesNotAffect = {
    delinquency: false,
    entitlement: false,
    babyFallback: false,
    grace: false,
    periodAdvance: false,
  };
  throw err;
}

/**
 * Resume canais de notificações individuais (auditoria — sem mutação).
 * @param {Record<string, unknown>[]} notifications
 */
export function summarizeCustomerNotificationChannels(notifications) {
  let emailEnabled = 0;
  let smsEnabled = 0;
  let whatsappEnabled = 0;
  let phoneEnabled = 0;
  let enabledTrue = 0;
  for (const n of notifications) {
    if (n?.enabled === true) enabledTrue += 1;
    if (n?.emailEnabledForCustomer === true) emailEnabled += 1;
    if (n?.smsEnabledForCustomer === true) smsEnabled += 1;
    if (n?.whatsappEnabledForCustomer === true) whatsappEnabled += 1;
    if (n?.phoneCallEnabledForCustomer === true) phoneEnabled += 1;
  }
  return {
    total: notifications.length,
    enabledTrue,
    emailEnabledForCustomer: emailEnabled,
    smsEnabledForCustomer: smsEnabled,
    whatsappEnabledForCustomer: whatsappEnabled,
    phoneCallEnabledForCustomer: phoneEnabled,
  };
}
