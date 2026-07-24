// ======================================================================
// Webhook ML — gate franquia em duas etapas (S1.HF.6.9A.10)
// A) preflight sem admission → B) GET order → reserva se elegível
// Origem resolvida uma vez e transportada em todas as etapas.
// ======================================================================

import { fetchOrderById } from "../../../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import {
  applyMlOrderDetailToMarketplaceSales,
  reserveMlBillableSaleUpstreamGate,
  reserveMlBillableSaleAfterOfficialDateGate,
  resolveSnapshotOriginForSyncType,
} from "./mlSalesSyncService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplaceAccountId
 * @param {string | null | undefined} sellerCompanyId
 * @param {string} externalOrderId
 * @param {string} accessToken
 * @param {{
 *   summary?: { errors: string[]; skipped_count: number; synced_count: number; created_count: number; updated_count: number };
 *   traceCtx?: Record<string, unknown>;
 *   options?: Record<string, unknown>;
 *   orderDetail?: Record<string, unknown> | null;
 * }} [ctx]
 */
export async function processMlOrderWebhookWithBillableAdmissionGate(
  supabase,
  userId,
  marketplaceAccountId,
  sellerCompanyId,
  externalOrderId,
  accessToken,
  ctx = {},
) {
  const summary = ctx.summary ?? {
    errors: [],
    skipped_count: 0,
    synced_count: 0,
    created_count: 0,
    updated_count: 0,
  };

  const snapshotOrigin = resolveSnapshotOriginForSyncType(
    ctx.options?.syncType ?? ctx.traceCtx?.syncType ?? "operational_webhook",
    ctx.options?.snapshotOrigin ?? ctx.options?.snapshot_origin,
  );

  const gate = await reserveMlBillableSaleUpstreamGate(
    supabase,
    userId,
    marketplaceAccountId,
    externalOrderId,
    {
      ...(ctx.options ?? {}),
      snapshotOrigin,
      syncType: ctx.options?.syncType ?? "operational_webhook",
    },
  );

  if (gate.idempotent && gate.sales_order_id) {
    return {
      ok: true,
      webhook_ok: true,
      gated: true,
      gate,
      ml_api_calls: 0,
      snapshot_origin: snapshotOrigin,
      idempotent: true,
    };
  }

  if (!gate.proceed) {
    return {
      ok: gate.webhook_ok !== false,
      webhook_ok: gate.webhook_ok !== false,
      gated: true,
      gate,
      ml_api_calls: 0,
      snapshot_origin: snapshotOrigin,
    };
  }

  let orderDetail = ctx.orderDetail ?? null;
  let mlApiCalls = 0;

  if (!orderDetail?.id && (gate.is_new_sale !== false || gate.fetch_order_for_update)) {
    orderDetail = await fetchOrderById(accessToken, externalOrderId, {
      marketplaceAccountId: marketplaceAccountId || null,
    });
    mlApiCalls += 1;
  }

  if (!orderDetail?.id) {
    return {
      ok: true,
      webhook_ok: true,
      gated: true,
      gate: {
        ...gate,
        reason: "order_detail_missing",
        manual_review_required: true,
      },
      ml_api_calls: mlApiCalls,
      snapshot_origin: snapshotOrigin,
    };
  }

  let atomicAdmission = gate.atomic_admission ?? null;

  if (gate.reserve_after_official_date && gate.is_new_sale !== false) {
    const dateCreated = orderDetail?.date_created ?? null;
    atomicAdmission = await reserveMlBillableSaleAfterOfficialDateGate(
      supabase,
      userId,
      marketplaceAccountId,
      externalOrderId,
      {
        date_created_marketplace: dateCreated,
        snapshot_origin: snapshotOrigin,
        reservation_owner_token: gate.reservation_owner_token ?? ctx.options?.reservation_owner_token,
      },
    );

    if (!atomicAdmission?.admit || atomicAdmission?.process_sale === false) {
      return {
        ok: true,
        webhook_ok: true,
        gated: true,
        gate: {
          ...gate,
          entitlement_blocked: !atomicAdmission?.webhook_ok ? true : Boolean(atomicAdmission?.manual_review_required),
          reason: atomicAdmission?.reason ?? "entitlement_blocked",
          atomic_admission: atomicAdmission,
          schedule_reconciliation: Boolean(atomicAdmission?.schedule_reconciliation),
          manual_review_required: Boolean(atomicAdmission?.manual_review_required),
        },
        ml_api_calls: mlApiCalls,
        snapshot_origin: snapshotOrigin,
      };
    }
  }

  const applyResult = await applyMlOrderDetailToMarketplaceSales(
    supabase,
    userId,
    marketplaceAccountId,
    sellerCompanyId,
    orderDetail,
    new Date().toISOString(),
    summary,
    accessToken,
    ctx.traceCtx ?? {},
    {
      ...(ctx.options ?? {}),
      atomic_admission: atomicAdmission,
      snapshotOrigin,
      syncType: ctx.options?.syncType ?? "operational_webhook",
    },
  );

  return {
    ...applyResult,
    gated: true,
    gate: { ...gate, atomic_admission: atomicAdmission },
    ml_api_calls: mlApiCalls,
    snapshot_origin: snapshotOrigin,
  };
}
