import { ML_MARKETPLACE_SLUG } from "../../../../handlers/ml/_helpers/mlMarketplace.js";
import { fetchMercadoLibreUserById } from "../../../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { persistMercadoLibreOrder } from "../../../../handlers/ml/_helpers/mlSalesPersist.js";
import { extractBuyerThumbFromOrderRaw } from "../../../../handlers/sales/_vendasSalesRows.js";
import { enrichMercadoLibreSaleFinancialSnapshot } from "../../../../services/marketplace/mercadoLivreSaleFinancialEnrichment.js";
import { notifyBillableSaleRecorded } from "../../../../billing/services/billingBillableSaleEntitlementHook.js";
import {
  finalizeBillableSaleV2,
  rollbackBillableSaleAdmission,
  recordBillableSaleIgnoredAtHardLimit,
  runWithBillableSaleReservationHeartbeat,
  reportBillableSaleFinalizeFailure,
} from "../../../../billing/services/billingBillableSaleAdmissionService.js";
import {
  preflightBillableSaleEntitlementState,
  reserveBillableSaleAfterOfficialDate,
} from "../../../../billing/services/billingBillableSalePreflightService.js";
import { BILLING_SNAPSHOT_ORIGIN } from "../../../../billing/billingConstants.js";
import { normalizeBillingSnapshotOrigin } from "../../../../billing/services/billingQuotaEligibilityService.js";

/**
 * Origem canônica única (S1.HF.6.9A.10). Ausência → unknown (nunca post_suse7_sale).
 *
 * @param {string | null | undefined} syncType
 * @param {string | null | undefined} [explicitOrigin]
 */
export function resolveSnapshotOriginForSyncType(syncType, explicitOrigin = null) {
  if (explicitOrigin != null && String(explicitOrigin).trim() !== "") {
    return normalizeBillingSnapshotOrigin(explicitOrigin);
  }
  const t = syncType != null ? String(syncType).trim().toLowerCase() : "";
  if (!t) return BILLING_SNAPSHOT_ORIGIN.UNKNOWN;
  if (t.startsWith("ml_initial_") || t.startsWith("ml_historical_")) {
    return BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT;
  }
  if (t.includes("webhook") || t === "operational_webhook") {
    return BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_WEBHOOK;
  }
  if (t.includes("reconcil")) {
    return BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_RECONCILIATION;
  }
  if (t.includes("sync") || t.startsWith("ml_")) {
    return BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_SYNC;
  }
  return BILLING_SNAPSHOT_ORIGIN.UNKNOWN;
}

function isColumnError(error) {
  return (
    String(error?.code ?? "") === "42703" ||
    String(error?.message ?? "").toLowerCase().includes("column")
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown> | null | undefined} atomicAdmission
 */
async function finalizeNewSaleAdmission(supabase, userId, atomicAdmission) {
  if (!atomicAdmission?.admission_id || !atomicAdmission?.reservation_owner_token || !atomicAdmission?.atomic) {
    return atomicAdmission;
  }

  let finalizeOk = false;
  let next = { ...atomicAdmission };

  try {
    const finalizeResult = await finalizeBillableSaleV2(supabase, {
      userId,
      reservationId: String(atomicAdmission.admission_id),
      reservationOwnerToken: String(atomicAdmission.reservation_owner_token),
      persistedAt: new Date(),
    });
    finalizeOk = Boolean(finalizeResult?.finalized);
    next = {
      ...next,
      finalize: finalizeResult,
      finalize_ok: finalizeOk,
      activate_hard_pause: Boolean(finalizeResult?.activate_hard_pause),
      pause_applied: Boolean(finalizeResult?.pause_applied),
    };
  } catch (finalizeErr) {
    console.warn("[Suse7][API][ml-sales-apply] admission_finalize_failed", {
      message: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
      admission_id: atomicAdmission.admission_id,
    });
    next = {
      ...next,
      finalize_failed: true,
      reconciliation_required: true,
    };
  }

  if (!finalizeOk) {
    next = {
      ...next,
      finalize_failed: true,
      reconciliation_required: true,
    };
    try {
      await reportBillableSaleFinalizeFailure(supabase, {
        userId,
        reservationId: String(atomicAdmission.admission_id),
        reservationOwnerToken: String(atomicAdmission.reservation_owner_token),
        reason: "finalize_failed",
      });
      next = {
        ...next,
        recovery_required: true,
        recovery_marked: true,
      };
    } catch (recoveryErr) {
      console.warn("[Suse7][API][ml-sales-apply] admission_recovery_mark_failed", {
        message: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        admission_id: atomicAdmission.admission_id,
      });
    }
  }

  return next;
}

/**
 * Gate upstream etapa A (6.9A.9): preflight sem criar admission.
 * HARD_PAUSED → zero GET; trial → segue sem reserva; Baby → reserva só após data oficial.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplaceAccountId
 * @param {string} externalOrderId
 * @param {{ reservation_owner_token?: string | null }} [options]
 */
export async function reserveMlBillableSaleUpstreamGate(
  supabase,
  userId,
  marketplaceAccountId,
  externalOrderId,
  options = {},
) {
  const extOrderId = externalOrderId != null ? String(externalOrderId).trim() : "";
  if (!extOrderId) {
    return { ok: false, proceed: false, webhook_ok: true, reason: "order_without_id" };
  }
  if (!marketplaceAccountId || String(marketplaceAccountId).trim() === "") {
    return { ok: false, proceed: false, webhook_ok: true, reason: "missing_marketplace_account_id" };
  }

  const { data: existing, error: exErr } = await supabase
    .from("sales_orders")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("marketplace_account_id", marketplaceAccountId)
    .eq("external_order_id", extOrderId)
    .maybeSingle();
  if (exErr) throw exErr;

  const snapshotOrigin = resolveSnapshotOriginForSyncType(
    options.syncType ?? options.sync_type,
    options.snapshotOrigin ?? options.snapshot_origin,
  );

  if (existing?.id && options.require_update !== true) {
    return {
      ok: true,
      proceed: false,
      webhook_ok: true,
      is_new_sale: false,
      idempotent: true,
      sales_order_id: String(existing.id),
      reserve_after_official_date: false,
      snapshot_origin: snapshotOrigin,
      ml_api_calls: 0,
      reason: "existing_sale_idempotent",
    };
  }

  if (existing?.id && options.require_update === true) {
    return {
      ok: true,
      proceed: true,
      webhook_ok: true,
      is_new_sale: false,
      sales_order_id: String(existing.id),
      reserve_after_official_date: false,
      fetch_order_for_update: true,
      snapshot_origin: snapshotOrigin,
    };
  }

  const preflight = await preflightBillableSaleEntitlementState(supabase, userId, {
    now: options.now instanceof Date ? options.now : undefined,
    snapshot_origin: snapshotOrigin,
  });

  if (!preflight.proceed) {
    if (
      preflight.reason === "hard_paused" ||
      preflight.reason === "baby_quota_hard_paused"
    ) {
      try {
        await recordBillableSaleIgnoredAtHardLimit(supabase, userId, {
          marketplace: ML_MARKETPLACE_SLUG,
          marketplace_account_id: marketplaceAccountId,
          reason: preflight.domain_code ?? "BABY_HARD_LIMIT_REACHED",
        });
      } catch (auditErr) {
        console.warn("[Suse7][API][ml-sales-upstream-gate] hard_paused_audit_failed", {
          message: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
    }
    return {
      ok: true,
      proceed: false,
      webhook_ok: true,
      is_new_sale: true,
      entitlement_blocked: true,
      reason: preflight.reason,
      domain_code: preflight.domain_code ?? null,
      preflight: true,
      snapshot_origin: snapshotOrigin,
      ml_api_calls: 0,
    };
  }

  return {
    ok: true,
    proceed: true,
    webhook_ok: true,
    is_new_sale: true,
    reserve_after_official_date: Boolean(preflight.reserve_after_official_date),
    quota_bypassed: Boolean(preflight.quota_bypassed),
    preflight_reason: preflight.reason,
    period_class: preflight.period_class ?? null,
    reservation_owner_token: options.reservation_owner_token ?? null,
    snapshot_origin: snapshotOrigin,
    atomic_admission: preflight.quota_bypassed
      ? {
          admit: true,
          process_sale: true,
          reason: preflight.reason,
          atomic: false,
          quota_bypassed: true,
          period_class: preflight.period_class ?? null,
          snapshot_origin: snapshotOrigin,
        }
      : null,
  };
}

/**
 * Etapa B — reserva atômica após conhecer date_created oficial.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplaceAccountId
 * @param {string} externalOrderId
 * @param {{
 *   date_created_marketplace?: unknown;
 *   snapshot_origin?: string | null;
 *   reservation_owner_token?: string | null;
 * }} [options]
 */
export async function reserveMlBillableSaleAfterOfficialDateGate(
  supabase,
  userId,
  marketplaceAccountId,
  externalOrderId,
  options = {},
) {
  return reserveBillableSaleAfterOfficialDate(supabase, userId, {
    external_order_id: String(externalOrderId),
    marketplace: ML_MARKETPLACE_SLUG,
    marketplace_account_id: String(marketplaceAccountId),
    date_created_marketplace: options.date_created_marketplace,
    snapshot_origin: options.snapshot_origin ?? null,
    reservation_owner_token: options.reservation_owner_token ?? null,
  });
}

/**
 * GET /orders/:id muitas vezes não traz foto do comprador no `buyer`; o GET /users/:id costuma incluir `thumbnail`.
 * @param {Record<string, unknown>} order
 * @param {string} accessToken
 * @param {{ marketplaceAccountId?: string | null }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function enrichMlOrderBuyerThumbnailIfNeeded(order, accessToken, options = {}) {
  if (!order || typeof order !== "object") return order;
  if (!accessToken || String(accessToken).trim() === "") return order;
  if (extractBuyerThumbFromOrderRaw(order)) return order;
  const buyer = order.buyer && typeof order.buyer === "object" ? /** @type {Record<string, unknown>} */ (order.buyer) : null;
  const bid = buyer?.id != null ? String(buyer.id).trim() : "";
  if (!bid) return order;
  try {
    const profile = await fetchMercadoLibreUserById(accessToken, bid, options);
    if (!profile || typeof profile !== "object") return order;
    const p = /** @type {Record<string, unknown>} */ (profile);
    const merged = { ...buyer };
    for (const k of ["thumbnail", "secure_thumbnail", "picture", "photo"]) {
      if (p[k] != null && merged[k] == null) merged[k] = p[k];
    }
    if (!extractBuyerThumbFromOrderRaw({ ...order, buyer: merged })) return order;
    return { ...order, buyer: merged };
  } catch {
    return order;
  }
}

async function applyOrderScopeColumns(supabase, salesOrderId, marketplaceAccountId, sellerCompanyId) {
  if (!salesOrderId) return;
  const scopePatches = [
    {
      sales_orders: {
        marketplace_account_id: marketplaceAccountId || null,
        seller_company_id: sellerCompanyId || null,
      },
      sales_order_items: {
        marketplace_account_id: marketplaceAccountId || null,
        seller_company_id: sellerCompanyId || null,
      },
    },
    {
      sales_orders: { marketplace_account_id: marketplaceAccountId || null },
      sales_order_items: { marketplace_account_id: marketplaceAccountId || null },
    },
    {
      sales_orders: { seller_company_id: sellerCompanyId || null },
      sales_order_items: { seller_company_id: sellerCompanyId || null },
    },
  ];

  for (const patch of scopePatches) {
    const { error: oErr } = await supabase
      .from("sales_orders")
      .update(patch.sales_orders)
      .eq("id", salesOrderId);
    if (oErr && !isColumnError(oErr)) throw oErr;
    if (oErr) continue;

    const { error: iErr } = await supabase
      .from("sales_order_items")
      .update(patch.sales_order_items)
      .eq("sales_order_id", salesOrderId);
    if (iErr && !isColumnError(iErr)) throw iErr;
    return;
  }
}

/**
 * Aplica um pedido ML no storage transacional de vendas do Suse7.
 * Fluxo Baby: RESERVE (ou upstream) → persist mínima → FINALIZE → enriquecimentos opcionais.
 */
export async function applyMlOrderDetailToMarketplaceSales(
  supabase,
  userId,
  marketplaceAccountId,
  sellerCompanyId,
  orderDetail,
  nowIso,
  summary,
  accessToken,
  traceCtx = {},
  options = {}
) {
  const syncTypeRaw =
    options?.syncType != null && String(options.syncType).trim() !== ""
      ? String(options.syncType).trim()
      : traceCtx?.syncType != null && String(traceCtx.syncType).trim() !== ""
        ? String(traceCtx.syncType).trim()
        : null;
  const snapshotOrigin = resolveSnapshotOriginForSyncType(
    syncTypeRaw,
    options?.snapshotOrigin ?? options?.snapshot_origin,
  );
  const reconstructionReferenceDate =
    snapshotOrigin === "onboarding_import"
      ? options?.reconstructionReferenceDate != null && String(options.reconstructionReferenceDate).trim() !== ""
        ? String(options.reconstructionReferenceDate).trim()
        : new Date().toISOString()
      : null;

  void nowIso;

  const extOrderId = orderDetail?.id != null ? String(orderDetail.id) : null;
  const logStep = (step, extra = {}) => {
    console.info("[S7][ml-sales-sync-order-step]", {
      syncRunId: traceCtx.syncRunId ?? null,
      marketplaceAccountId,
      sellerCompanyId,
      externalOrderId: extOrderId,
      index: traceCtx.orderIndex ?? null,
      total: traceCtx.total ?? null,
      step,
      ...extra,
    });
  };
  if (!extOrderId) {
    summary.errors.push("order_without_id");
    summary.skipped_count += 1;
    return { ok: false, reason: "order_without_id" };
  }

  if (!marketplaceAccountId || String(marketplaceAccountId).trim() === "") {
    summary.errors.push("missing_marketplace_account_id");
    summary.skipped_count += 1;
    return { ok: false, reason: "missing_marketplace_account_id" };
  }

  const existingQuery = supabase
    .from("sales_orders")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("marketplace_account_id", marketplaceAccountId)
    .eq("external_order_id", extOrderId);
  const { data: existing, error: exErr } = await existingQuery.maybeSingle();
  if (exErr) throw exErr;

  const isNewSale = !existing?.id;
  /** @type {Record<string, unknown> | null} */
  let atomicAdmission =
    options?.atomic_admission && typeof options.atomic_admission === "object"
      ? /** @type {Record<string, unknown>} */ (options.atomic_admission)
      : null;

  if (isNewSale && !atomicAdmission) {
    // 6.9A.9 — sem admission prévia: reserva só após date_created oficial (nunca pré-GET).
    logStep("entitlement admission after official date");
    atomicAdmission = await reserveBillableSaleAfterOfficialDate(supabase, userId, {
      external_order_id: extOrderId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplace_account_id: marketplaceAccountId,
      date_created_marketplace: orderDetail?.date_created ?? null,
      snapshot_origin: snapshotOrigin,
      reservation_owner_token: options?.reservation_owner_token ?? null,
    });
    if (!atomicAdmission?.admit || atomicAdmission?.process_sale === false) {
      summary.skipped_count += 1;
      summary.errors.push(`entitlement_${atomicAdmission?.reason ?? "blocked"}`);
      logStep("entitlement admission rejected", {
        reason: atomicAdmission?.reason,
        process_sale: atomicAdmission?.process_sale ?? null,
      });
      if (
        atomicAdmission?.reason === "hard_paused" ||
        atomicAdmission?.reason === "baby_hard_limit_reached"
      ) {
        try {
          await recordBillableSaleIgnoredAtHardLimit(supabase, userId, {
            marketplace: ML_MARKETPLACE_SLUG,
            marketplace_account_id: marketplaceAccountId || null,
            reason: atomicAdmission?.domain_code ?? "BABY_HARD_LIMIT_REACHED",
          });
        } catch (auditErr) {
          console.warn("[Suse7][API][ml-sales-apply] hard_paused_audit_failed", {
            message: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      }
      return {
        ok: false,
        reason: atomicAdmission?.reason ?? "entitlement_blocked",
        entitlement_blocked: true,
        domain_code: atomicAdmission?.domain_code ?? null,
        webhook_ok: true,
      };
    }
  }

  logStep("persist order minimal");
  let out;
  try {
    out = await runWithBillableSaleReservationHeartbeat(supabase, userId, atomicAdmission, () =>
      persistMercadoLibreOrder(supabase, userId, orderDetail, {
        marketplace: ML_MARKETPLACE_SLUG,
        marketplaceAccountId: marketplaceAccountId || null,
        sellerCompanyId: sellerCompanyId || null,
        accessToken: accessToken && String(accessToken).trim() !== "" ? String(accessToken).trim() : undefined,
        traceCtx,
        log: (msg, extra) => {
          console.log("[Suse7][API][ml-sales-apply]", msg, extra ?? {});
        },
      }),
    );
  } catch (persistErr) {
    if (atomicAdmission?.admission_id && atomicAdmission?.reservation_owner_token) {
      try {
        await rollbackBillableSaleAdmission(supabase, {
          userId,
          admissionId: String(atomicAdmission.admission_id),
          reservationOwnerToken: String(atomicAdmission.reservation_owner_token),
          reason: "persist_failed",
        });
      } catch (rollbackErr) {
        console.warn("[Suse7][API][ml-sales-apply] admission_release_failed", {
          message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          admission_id: atomicAdmission.admission_id,
        });
      }
    }
    throw persistErr;
  }
  logStep("persist items");

  if (isNewSale) {
    logStep("entitlement finalize reservation");
    atomicAdmission = await finalizeNewSaleAdmission(supabase, userId, atomicAdmission);
  }

  logStep("enrich buyer thumbnail optional");
  const orderForEnrichment = await enrichMlOrderBuyerThumbnailIfNeeded(
    /** @type {Record<string, unknown>} */ (orderDetail),
    accessToken,
    { marketplaceAccountId: marketplaceAccountId || null },
  );

  if (accessToken && String(accessToken).trim() !== "" && out?.salesOrderId) {
    logStep("enrich financial snapshot optional");
    try {
      await enrichMercadoLibreSaleFinancialSnapshot(supabase, userId, orderForEnrichment, {
        accessToken: String(accessToken).trim(),
        marketplaceAccountId: marketplaceAccountId || null,
        salesOrderId: String(out.salesOrderId),
        logContext: "ml_sales_sync",
        snapshotOrigin,
        reconstructionReferenceDate,
      });
    } catch (enrichErr) {
      console.warn("[Suse7][API][ml-sales-apply] financial_enrichment_failed", {
        message: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
        external_order_id: extOrderId,
      });
    }
  }

  logStep("persist customer");
  await applyOrderScopeColumns(
    supabase,
    out?.salesOrderId ?? existing?.id ?? null,
    marketplaceAccountId,
    sellerCompanyId
  );
  logStep("snapshot");
  logStep("metrics");

  summary.synced_count += 1;
  if (existing?.id) summary.updated_count += 1;
  else summary.created_count += 1;

  if (isNewSale) {
    logStep("entitlement post-sale transition");
    try {
      await notifyBillableSaleRecorded(supabase, userId, {
        is_new_sale: true,
        external_order_id: extOrderId,
        atomic_admission: atomicAdmission,
        snapshot_origin: snapshotOrigin,
        period_class: atomicAdmission?.period_class ?? null,
        official_order_at:
          atomicAdmission?.official_order_at ??
          (orderDetail?.date_created != null ? String(orderDetail.date_created) : null),
      });
    } catch (hookErr) {
      console.warn("[Suse7][API][ml-sales-apply] entitlement_hook_failed", {
        message: hookErr instanceof Error ? hookErr.message : String(hookErr),
        external_order_id: extOrderId,
      });
    }
  }

  return { ok: true, salesOrderId: out?.salesOrderId ?? existing?.id ?? null };
}
