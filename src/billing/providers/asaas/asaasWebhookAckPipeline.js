// ======================================================================
// Asaas webhook — ACK HTTP (persist sync + apply async)
// ======================================================================

import { recordBillingEvent } from "../../billingEventService.js";
import {
  acceptAsaasWebhook,
  logAsaasWebhook,
  logAsaasWebhookError,
  processAsaasWebhookBackground,
} from "./asaasWebhookHandler.js";

/**
 * @param {string} tag
 * @param {Record<string, unknown>} payload
 */
function logAsaasWebhookOps(tag, payload = {}) {
  console.info(tag, payload);
}

/**
 * Persiste evento bruto antes do ACK 200 (idempotência por provider_event_id).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   rawObj: Record<string, unknown>;
 *   norm: import("./asaasEventNormalizer.js").normalizeAsaasWebhook extends (...args: infer _A) => infer R ? R : never;
 *   providerEventId: string;
 * }} job
 */
export async function persistAsaasWebhookEventSync(supabase, job) {
  const recorded = await recordBillingEvent(supabase, {
    provider: "asaas",
    providerEventId: job.providerEventId,
    eventType: job.norm.eventType,
    rawPayload: job.rawObj,
  });
  return {
    duplicate: recorded.duplicate === true,
    eventId: recorded.eventId,
  };
}

/**
 * Pipeline HTTP: validar → persistir → ACK 200 → aplicar regras em background.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("http").IncomingMessage} req
 * @param {string} expectedWebhookToken
 * @param {{ traceId?: string | null }} [ctx]
 */
export async function runAsaasWebhookAckPipeline(supabase, req, expectedWebhookToken, ctx = {}) {
  const traceId = ctx.traceId ?? null;
  const accepted = await acceptAsaasWebhook(req, expectedWebhookToken, { traceId });

  if (!accepted.ok) {
    if (accepted.status === 401) {
      logAsaasWebhookOps("[ASAAS_WEBHOOK_VALIDATION_FAILED]", {
        trace_id: traceId,
        http_status: accepted.status,
        reason: "invalid_webhook_token",
      });
    }
    return {
      httpStatus: accepted.status,
      body: accepted.body,
      runBackground: false,
      job: null,
    };
  }

  logAsaasWebhookOps("[ASAAS_WEBHOOK_RECEIVED]", {
    trace_id: traceId,
    provider_event_id: accepted.job.providerEventId,
    event_type: accepted.job.norm.eventType,
    payment_id: accepted.job.norm.paymentId ?? null,
    subscription_id: accepted.job.norm.subscriptionId ?? null,
    ack_duration_ms: accepted.ackDurationMs,
  });

  /** @type {{ duplicate: boolean; eventId: string | null; warning: string | null }} */
  let persist = { duplicate: false, eventId: null, warning: null };

  try {
    const recorded = await persistAsaasWebhookEventSync(supabase, accepted.job);
    persist = { ...recorded, warning: null };
    logAsaasWebhookOps("[ASAAS_WEBHOOK_EVENT_STORED]", {
      trace_id: traceId,
      provider_event_id: accepted.job.providerEventId,
      event_type: accepted.job.norm.eventType,
      event_id: persist.eventId,
      duplicate: persist.duplicate,
    });
    logAsaasWebhook("event_recorded_sync", {
      received_at: accepted.receivedAt,
      provider_event_id: accepted.job.providerEventId,
      event_id: persist.eventId,
      duplicate: persist.duplicate,
    });
  } catch (persistErr) {
    const message = persistErr instanceof Error ? persistErr.message : String(persistErr ?? "");
    persist.warning = message;
    logAsaasWebhookOps("[ASAAS_WEBHOOK_PROCESSING_FAILED]", {
      trace_id: traceId,
      phase: "persist",
      provider_event_id: accepted.job.providerEventId,
      event_type: accepted.job.norm.eventType,
      error_message: message,
    });
    logAsaasWebhookError("persist_sync_failed", persistErr, {
      provider_event_id: accepted.job.providerEventId,
      trace_id: traceId,
    });
  }

  const body = {
    ok: true,
    accepted: true,
    duplicate: persist.duplicate,
    provider_event_id: accepted.job.providerEventId,
    event_type: accepted.job.norm.eventType,
    event_id: persist.eventId,
    ...(persist.warning ? { warning: persist.warning } : {}),
    ...(traceId ? { traceId } : {}),
  };

  logAsaasWebhookOps("[ASAAS_WEBHOOK_ACK_200]", {
    trace_id: traceId,
    provider_event_id: accepted.job.providerEventId,
    event_type: accepted.job.norm.eventType,
    duplicate: persist.duplicate,
    persist_warning: persist.warning,
  });

  return {
    httpStatus: 200,
    body,
    runBackground: !persist.duplicate,
    job: {
      ...accepted.job,
      eventId: persist.eventId,
      skipRecord: true,
      duplicate: persist.duplicate,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {NonNullable<Awaited<ReturnType<typeof runAsaasWebhookAckPipeline>>["job"]>} job
 * @param {{ traceId?: string | null }} [ctx]
 */
export function dispatchAsaasWebhookBackgroundApply(supabase, job, ctx = {}) {
  return processAsaasWebhookBackground(supabase, job).catch((bgErr) => {
    logAsaasWebhookOps("[ASAAS_WEBHOOK_PROCESSING_FAILED]", {
      trace_id: ctx.traceId ?? job.traceId ?? null,
      phase: "background_apply",
      provider_event_id: job.providerEventId,
      event_type: job.norm.eventType,
      error_message: bgErr instanceof Error ? bgErr.message : String(bgErr),
    });
    logAsaasWebhookError("background_apply_failed", bgErr, {
      provider_event_id: job.providerEventId,
      trace_id: ctx.traceId ?? job.traceId ?? null,
    });
  });
}
