// ======================================================================
// Asaas — orquestração do webhook (validação → evento → estado)
// Asaas — webhook ACK-first (resposta rápida) + processamento em background.

// ======================================================================



import { createHash } from "node:crypto";

import { readRequestBodyBuffer } from "../../../infra/readRequestBodyBuffer.js";

import { logBillingError } from "../../billingLog.js";

import { recordBillingEvent, finalizeBillingEvent } from "../../billingEventService.js";

import { applyAsaasWebhookEvent } from "../../subscriptionStateService.js";

import { buildBillingObservabilityContext } from "../../utils/billingObservability.js";

import { normalizeAsaasWebhook } from "./asaasEventNormalizer.js";

import { validateAsaasWebhookToken } from "./asaasSignatureValidator.js";



const DEFAULT_BACKGROUND_TIMEOUT_MS = Math.min(

  55_000,

  Math.max(5_000, parseInt(process.env.S7_ASAAS_WEBHOOK_BACKGROUND_TIMEOUT_MS || "25000", 10) || 25_000),

);



/**

 * @param {string} step

 * @param {Record<string, unknown>} [payload]

 */

export function logAsaasWebhook(step, payload = {}) {

  const duration_ms =

    payload.duration_ms ??

    (payload.received_at != null && typeof payload.received_at === "number"

      ? Date.now() - payload.received_at

      : undefined);

  console.info("[S7_ASAAS_WEBHOOK]", {

    step,

    ...payload,

    ...(duration_ms != null ? { duration_ms } : {}),

  });

}



/**

 * @param {string} step

 * @param {unknown} err

 * @param {Record<string, unknown>} [payload]

 */

export function logAsaasWebhookError(step, err, payload = {}) {

  const message = err instanceof Error ? err.message : String(err ?? "");

  const stack = err instanceof Error ? err.stack : undefined;

  console.error("[S7_ASAAS_WEBHOOK]", {

    step,

    error: message,

    ...(stack ? { stack } : {}),

    ...payload,

  });

}



/**

 * @param {Record<string, unknown>} rawObj

 * @returns {Record<string, unknown>}

 */

function buildSafePayloadLog(rawObj) {

  const norm = normalizeAsaasWebhook(rawObj);

  const payment = norm.payment;

  const subscription = norm.subscription;

  return {

    event_type: norm.eventType,

    provider_event_id: norm.providerEventId,

    kind: norm.kind,

    payment_id: norm.paymentId,

    subscription_id: norm.subscriptionId,

    billing_type:

      payment && typeof payment.billingType === "string" ? payment.billingType : null,

    payment_status: payment && typeof payment.status === "string" ? payment.status : null,

    customer_id:

      payment && typeof payment.customer === "string"

        ? payment.customer

        : payment && typeof payment.customer === "object" && payment.customer != null && "id" in payment.customer

          ? String(/** @type {{ id?: unknown }} */ (payment.customer).id ?? "")

          : subscription && typeof subscription.customer === "string"

            ? subscription.customer

            : null,

  };

}



/**

 * @param {Record<string, unknown>} rawObj

 * @returns {string}

 */

function fallbackProviderEventId(rawObj) {

  const digest = createHash("sha256").update(JSON.stringify(rawObj)).digest("hex").slice(0, 32);

  return `anon:${digest}`;

}



/**

 * @param {Promise<unknown>} promise

 * @param {number} timeoutMs

 * @param {string} label

 */

function withBackgroundTimeout(promise, timeoutMs, label) {

  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {

    timer = setTimeout(() => {

      reject(new Error(`background_timeout:${label}:${timeoutMs}ms`));

    }, timeoutMs);

  });

  return Promise.race([promise, timeoutPromise]).finally(() => {

    if (timer) clearTimeout(timer);

  });

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string | null} eventId

 * @param {{ status: "processed" | "failed"; error?: string | null }} outcome

 */

async function safeFinalizeBillingEvent(supabase, eventId, outcome) {

  if (!eventId) return;

  try {

    await finalizeBillingEvent(supabase, eventId, outcome);

  } catch (finalizeErr) {

    logAsaasWebhookError("finalize_billing_event_failed", finalizeErr, {

      event_id: eventId,

      status: outcome.status,

    });

  }

}



/**

 * Fase rápida: valida token, parseia JSON, normaliza — sem Supabase.

 *

 * @param {import("http").IncomingMessage & { body?: unknown; bodyBuffer?: Buffer }} req

 * @param {string} expectedWebhookToken

 * @param {{ traceId?: string | null }} [ctx]

 */

export async function acceptAsaasWebhook(req, expectedWebhookToken, ctx = {}) {

  const receivedAt = Date.now();



  logAsaasWebhook("received", {

    received_at: receivedAt,

    method: req.method ?? null,

    trace_id: ctx.traceId ?? null,

  });



  if (!validateAsaasWebhookToken(req, expectedWebhookToken)) {

    logAsaasWebhook("unauthorized", { received_at: receivedAt, duration_ms: Date.now() - receivedAt });

    return { ok: false, status: 401, body: { ok: false, error: "Webhook não autorizado" }, receivedAt };

  }



  logAsaasWebhook("validated", { received_at: receivedAt, duration_ms: Date.now() - receivedAt });



  let rawObj = /** @type {Record<string, unknown>} */ ({});

  try {

    const buf = await readRequestBodyBuffer(req);

    const raw = buf.toString("utf8").trim();

    if (raw) {

      const parsed = JSON.parse(raw);

      rawObj = typeof parsed === "object" && parsed != null && !Array.isArray(parsed) ? parsed : {};

    } else if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {

      rawObj = /** @type {Record<string, unknown>} */ (req.body);

    }

  } catch (parseErr) {

    logAsaasWebhookError("invalid_json", parseErr, { received_at: receivedAt });

    return { ok: false, status: 400, body: { ok: false, error: "JSON inválido" }, receivedAt };

  }



  const norm = normalizeAsaasWebhook(rawObj);

  const providerEventId = norm.providerEventId || fallbackProviderEventId(rawObj);

  const ackDurationMs = Date.now() - receivedAt;



  logAsaasWebhook("payload_normalized", {

    received_at: receivedAt,

    duration_ms: ackDurationMs,

    ...buildSafePayloadLog(rawObj),

  });



  return {

    ok: true,

    status: 202,

    receivedAt,

    ackDurationMs,

    body: {

      ok: true,

      accepted: true,

      ack_mode: "background",

      provider_event_id: providerEventId,

      event_type: norm.eventType,

    },

    job: {

      rawObj,

      norm,

      providerEventId,

      traceId: ctx.traceId ?? null,

      receivedAt,

    },

  };

}



/**

 * Processamento pesado (Supabase, timeline, assinatura) — após ACK ao Asaas.

 *

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {{

 *   rawObj: Record<string, unknown>;

 *   norm: ReturnType<typeof normalizeAsaasWebhook>;

 *   providerEventId: string;

 *   traceId?: string | null;

 *   receivedAt: number;

 * }} job

 * @param {{ timeoutMs?: number }} [options]

 */

export async function processAsaasWebhookBackground(supabase, job, options = {}) {

  const timeoutMs = options.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS;

  const bgStartedAt = Date.now();



  logAsaasWebhook("background_started", {

    received_at: job.receivedAt,

    provider_event_id: job.providerEventId,

    event_type: job.norm.eventType,

    trace_id: job.traceId ?? null,

    timeout_ms: timeoutMs,

  });



  const run = async () => {

    const { rawObj, norm, providerEventId } = job;

    const provider = "asaas";



    let eventId = job.eventId != null ? String(job.eventId) : null;

    let eventPersistenceWarning = null;

    if (job.duplicate === true || job.skipRecord === true) {
      if (job.duplicate === true) {
        logAsaasWebhook("background_finished", {
          received_at: job.receivedAt,
          provider_event_id: providerEventId,
          duplicate: true,
          duration_ms: Date.now() - bgStartedAt,
          note: "duplicate_ack_only",
        });
        return { duplicate: true, processed: false };
      }
    } else {
    try {

      const recorded = await recordBillingEvent(supabase, {

        provider,

        providerEventId,

        eventType: norm.eventType,

        rawPayload: rawObj,

      });

      if (recorded.duplicate) {

        logAsaasWebhook("background_finished", {

          received_at: job.receivedAt,

          provider_event_id: providerEventId,

          duplicate: true,

          duration_ms: Date.now() - bgStartedAt,

        });

        return { duplicate: true, processed: false };

      }

      eventId = recorded.eventId;

      logAsaasWebhook("event_recorded", {

        provider_event_id: providerEventId,

        event_id: eventId,

        duration_ms: Date.now() - bgStartedAt,

      });

    } catch (recordErr) {

      eventPersistenceWarning =

        recordErr instanceof Error ? recordErr.message : String(recordErr ?? "record_billing_event_failed");

      logAsaasWebhookError("record_billing_event_failed", recordErr, {

        provider_event_id: providerEventId,

        note: "continuing_without_event_row",

      });

    }

    }



    /** @type {string | null} */

    let errMsg = null;

    /** @type {string | null} */

    let actionTaken = null;



    try {

      if (!norm.supported || !norm.eventType) {

        errMsg = norm.eventType ? `event_not_handled:${norm.eventType}` : "missing_event_type";

        actionTaken = "ignored_unsupported";

      } else if (norm.kind === "payment" && (!norm.payment || !norm.paymentId)) {

        errMsg = "missing_payment_payload";

        actionTaken = "ignored_missing_payment";

      } else if (norm.kind === "subscription" && (!norm.subscription || !norm.subscriptionId)) {

        errMsg = "missing_subscription_payload";

        actionTaken = "ignored_missing_subscription";

      } else {

        await applyAsaasWebhookEvent(supabase, norm, { providerEventId });

        actionTaken = "applied";

        logAsaasWebhook("processed", {

          ...buildBillingObservabilityContext({

            provider_event_id: providerEventId,

            event_type: norm.eventType,

            payment_id: norm.paymentId ?? null,

            subscription_id: norm.subscriptionId ?? null,

            duration_ms: Date.now() - bgStartedAt,

            processed: true,

          }),

        });

      }

    } catch (processErr) {

      errMsg = processErr instanceof Error ? processErr.message : String(processErr);

      actionTaken = "processing_error";

      logAsaasWebhookError("processing_failed", processErr, {

        provider_event_id: providerEventId,

        event_type: norm.eventType,

        duration_ms: Date.now() - bgStartedAt,

      });

      logBillingError("webhook", "S7_BILLING_WEBHOOK_FAILED", processErr, {

        provider_event_id: providerEventId,

        event_type: norm.eventType,

        duration_ms: Date.now() - bgStartedAt,

      });

    }



    await safeFinalizeBillingEvent(supabase, eventId, {

      status: errMsg ? "failed" : "processed",

      error: errMsg,

    });



    logAsaasWebhook("background_finished", {

      received_at: job.receivedAt,

      provider_event_id: providerEventId,

      event_type: norm.eventType,

      action: actionTaken,

      warning: errMsg,

      event_persistence_warning: eventPersistenceWarning,

      processed: !errMsg && actionTaken === "applied",

      duration_ms: Date.now() - bgStartedAt,

      total_duration_ms: Date.now() - job.receivedAt,

    });



    return {

      duplicate: false,

      processed: !errMsg && actionTaken === "applied",

      warning: errMsg,

      action: actionTaken,

    };

  };



  try {

    return await withBackgroundTimeout(run(), timeoutMs, job.providerEventId);

  } catch (bgErr) {

    logAsaasWebhookError("background_failed", bgErr, {

      received_at: job.receivedAt,

      provider_event_id: job.providerEventId,

      event_type: job.norm.eventType,

      duration_ms: Date.now() - bgStartedAt,

      timeout_ms: timeoutMs,

    });

    throw bgErr;

  }

}



/**

 * Modo síncrono (scripts de validação / testes locais).

 *

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {import("http").IncomingMessage & { body?: unknown; bodyBuffer?: Buffer }} req

 * @param {string} expectedWebhookToken

 */

export async function handleAsaasWebhookRequest(supabase, req, expectedWebhookToken) {

  const accepted = await acceptAsaasWebhook(req, expectedWebhookToken);

  if (!accepted.ok) {

    return { ok: false, status: accepted.status, body: accepted.body };

  }



  logAsaasWebhook("response_sent", {

    received_at: accepted.receivedAt,

    provider_event_id: accepted.job.providerEventId,

    event_type: accepted.job.norm.eventType,

    ack_duration_ms: accepted.ackDurationMs,

    http_status: 202,

    mode: "sync_test",

  });



  const bg = await processAsaasWebhookBackground(supabase, accepted.job);



  if (bg.duplicate) {

    return {

      ok: true,

      status: 200,

      body: { ok: true, duplicate: true, provider_event_id: accepted.job.providerEventId },

    };

  }



  if (bg.warning) {

    return {

      ok: true,

      status: 200,

      body: {

        ok: true,

        processed: false,

        warning: bg.warning,

        provider_event_id: accepted.job.providerEventId,

      },

    };

  }



  return {

    ok: true,

    status: 202,

    body: {

      ok: true,

      processed: Boolean(bg.processed),

      provider_event_id: accepted.job.providerEventId,

    },

  };
}