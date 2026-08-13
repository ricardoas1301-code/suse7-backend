import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";

/** @typedef {'PERSISTED' | 'IDEMPOTENT_ALREADY_PRESENT' | 'IGNORED_ENTITLEMENT_BLOCKED' | 'IGNORED_MAINTENANCE' | 'RETRYABLE_FAILURE' | 'DEFINITIVE_SKIP'} MlWebhookOrderProcessorOutcome */

/**
 * Classifica resultado de applyMlOrderDetailToMarketplaceSales no contexto webhook orders_v2.
 *
 * @param {Record<string, unknown> | null | undefined} applyResult
 */
export function classifyMlWebhookApplyResult(applyResult) {
  if (!applyResult || typeof applyResult !== "object") {
    return {
      outcome: /** @type {MlWebhookOrderProcessorOutcome} */ ("RETRYABLE_FAILURE"),
      reason: "missing_apply_result",
      terminal: false,
    };
  }

  if (applyResult.ok === true) {
    return {
      outcome: /** @type {MlWebhookOrderProcessorOutcome} */ ("PERSISTED"),
      reason: null,
      terminal: true,
      salesOrderId: applyResult.salesOrderId != null ? String(applyResult.salesOrderId) : null,
    };
  }

  if (applyResult.entitlement_blocked === true) {
    return {
      outcome: /** @type {MlWebhookOrderProcessorOutcome} */ ("IGNORED_ENTITLEMENT_BLOCKED"),
      reason: applyResult.reason != null ? String(applyResult.reason) : "entitlement_blocked",
      domain_code: applyResult.domain_code != null ? String(applyResult.domain_code) : null,
      terminal: true,
    };
  }

  if (applyResult.maintenance_blocked === true) {
    return {
      outcome: /** @type {MlWebhookOrderProcessorOutcome} */ ("IGNORED_MAINTENANCE"),
      reason: applyResult.reason != null ? String(applyResult.reason) : "DEV_GLOBAL_MAINTENANCE",
      domain_code: applyResult.domain_code != null ? String(applyResult.domain_code) : null,
      terminal: true,
    };
  }

  const reason = applyResult.reason != null ? String(applyResult.reason) : "apply_failed";
  const definitiveSkips = new Set(["order_without_id", "missing_marketplace_account_id"]);
  if (definitiveSkips.has(reason)) {
    return {
      outcome: /** @type {MlWebhookOrderProcessorOutcome} */ ("DEFINITIVE_SKIP"),
      reason,
      terminal: true,
    };
  }

  return {
    outcome: /** @type {MlWebhookOrderProcessorOutcome} */ ("RETRYABLE_FAILURE"),
    reason,
    terminal: false,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ userId: string; marketplaceAccountId: string; externalOrderId: string }} input
 */
export async function verifySalesOrderCanonicalPresence(supabase, input) {
  const { data, error } = await supabase
    .from("sales_orders")
    .select("id")
    .eq("user_id", input.userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("marketplace_account_id", input.marketplaceAccountId)
    .eq("external_order_id", input.externalOrderId)
    .maybeSingle();
  if (error) throw error;
  return data?.id != null ? String(data.id) : null;
}

/**
 * Garante outcome terminal válido antes de marcar evento como done.
 * Lança erro com `.code` para branches retry/ignored do processor.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   applyResult: Record<string, unknown> | null | undefined;
 *   userId: string;
 *   marketplaceAccountId: string;
 *   externalOrderId: string;
 *   hadExistingBeforeApply?: boolean;
 * }} input
 */
export async function assertMlWebhookOrdersV2CanonicalOutcome(supabase, input) {
  const classified = classifyMlWebhookApplyResult(input.applyResult);

  if (classified.outcome === "IGNORED_ENTITLEMENT_BLOCKED") {
    const err = new Error(`ENTITLEMENT_BLOCKED:${classified.reason}`);
    /** @type {any} */ (err).code = "ML_WEBHOOK_ENTITLEMENT_BLOCKED";
    /** @type {any} */ (err).processor_outcome = classified.outcome;
    /** @type {any} */ (err).domain_code = classified.domain_code ?? null;
    throw err;
  }

  if (classified.outcome === "IGNORED_MAINTENANCE") {
    const err = new Error(`MAINTENANCE_BLOCKED:${classified.reason}`);
    /** @type {any} */ (err).code = "ML_WEBHOOK_MAINTENANCE_BLOCKED";
    /** @type {any} */ (err).processor_outcome = classified.outcome;
    /** @type {any} */ (err).domain_code = classified.domain_code ?? null;
    throw err;
  }

  if (classified.outcome === "DEFINITIVE_SKIP") {
    const err = new Error(`DEFINITIVE_SKIP:${classified.reason}`);
    /** @type {any} */ (err).code = "ML_WEBHOOK_DEFINITIVE_SKIP";
    /** @type {any} */ (err).processor_outcome = classified.outcome;
    throw err;
  }

  if (classified.outcome === "RETRYABLE_FAILURE") {
    const err = new Error(classified.reason ?? "APPLY_ML_ORDER_FAILED");
    /** @type {any} */ (err).code = "ML_WEBHOOK_APPLY_RETRYABLE";
    /** @type {any} */ (err).processor_outcome = classified.outcome;
    throw err;
  }

  const salesOrderId = await verifySalesOrderCanonicalPresence(supabase, {
    userId: input.userId,
    marketplaceAccountId: input.marketplaceAccountId,
    externalOrderId: input.externalOrderId,
  });

  if (!salesOrderId) {
    const err = new Error("PERSISTENCE_VERIFICATION_FAILED");
    /** @type {any} */ (err).code = "ML_WEBHOOK_PERSISTENCE_VERIFICATION_FAILED";
    /** @type {any} */ (err).processor_outcome = "RETRYABLE_FAILURE";
    throw err;
  }

  if (
    classified.salesOrderId &&
    String(classified.salesOrderId) !== String(salesOrderId)
  ) {
    const err = new Error("PERSISTENCE_VERIFICATION_MISMATCH");
    /** @type {any} */ (err).code = "ML_WEBHOOK_PERSISTENCE_VERIFICATION_FAILED";
    /** @type {any} */ (err).processor_outcome = "RETRYABLE_FAILURE";
    throw err;
  }

  const outcome =
    input.hadExistingBeforeApply === true
      ? /** @type {MlWebhookOrderProcessorOutcome} */ ("IDEMPOTENT_ALREADY_PRESENT")
      : /** @type {MlWebhookOrderProcessorOutcome} */ ("PERSISTED");

  return {
    outcome,
    salesOrderId,
    terminal: true,
    status: "done",
  };
}

/**
 * @param {unknown} err
 */
export function isMlWebhookTerminalIgnoredError(err) {
  const code =
    err && typeof err === "object" && "code" in err && err.code != null ? String(err.code) : "";
  return (
    code === "WEBHOOK_ACCOUNT_AMBIGUOUS" ||
    code === "ML_WEBHOOK_ENTITLEMENT_BLOCKED" ||
    code === "ML_WEBHOOK_MAINTENANCE_BLOCKED" ||
    code === "ML_WEBHOOK_DEFINITIVE_SKIP"
  );
}
