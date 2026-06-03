// =============================================================================

// Acionamento manual — Raio-X da Venda → Notification Actions Engine (3.5C.1.A3/A4)

// =============================================================================



import { S7_NOTIFICATION_CATEGORY } from "../constants/categories.js";

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";

import { S7_NOTIFICATION_DISPATCH_STATUS } from "../constants/dispatchStatus.js";

import { publishNotificationEvent } from "../events/publishNotificationEvent.js";

import { isWhatsAppLiveDeliveryActive } from "../whatsapp/S7WhatsAppProvider.js";

import { isRealEmailProviderConfigured } from "../email/S7EmailProvider.js";

import { loadSaleOrderItemForSeller } from "../../../sales/loadSaleOrderItemForSeller.js";

import { logNotificationActions } from "../actions/notificationActionsLog.js";

import { resolveCentralRecipients } from "../recipients/resolveCentralRecipients.js";

import {
  auditManualSaleRayxWhatsAppLive,
  buildManualRayxDestinationTrace,
  buildManualRayxOutboxPolicyMetadata,
  canProcessManualSaleRayxWhatsAppLive,
  evaluateManualRayxLiveSendPolicy,
  isExplicitSmokeDestinationRequest,
  MANUAL_RAYX_LIVE_DESTINATION_SOURCE,
  normalizeManualRayxPhone,
  patchManualRayxWhatsAppOutboxPolicy,
  patchManualRayxWhatsAppOutboxShare,
  resolveExplicitSmokePhoneForSeller,
} from "./manualSaleRayxLiveDelivery.js";
import { dedupeOfficialWhatsAppRecipients } from "../whatsapp/index.js";
import { recordRayxWhatsAppMotorObservability } from "./rayxWhatsAppMotorObservability.js";
import { isProviderSmokeEnabled } from "../providers/abstraction/providerSmokePolicy.js";

import { processWhatsAppOutboxDispatch } from "../whatsapp/processWhatsAppOutboxDispatch.js";

import { resolveWhatsAppProviderName } from "../providers/whatsapp/whatsappProviderEnv.js";



const MANUAL_TYPE = "MANUAL_SALE_RAYX";

const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;



/**

 * @param {string} channel

 * @param {string} phone

 * @param {string} email

 */

function resolveManualDestination(channel, phone, email) {

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP) {

    const digits = String(phone ?? "").replace(/\D/g, "");

    if (digits.length < 10) return { ok: false, error: "INVALID_PHONE" };

    return { ok: true, destination: digits };

  }

  if (channel === S7_NOTIFICATION_CHANNEL.EMAIL) {

    const addr = String(email ?? "").trim().toLowerCase();

    if (!addr || !addr.includes("@")) return { ok: false, error: "INVALID_EMAIL" };

    return { ok: true, destination: addr };

  }

  return { ok: false, error: "INVALID_CHANNEL" };

}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} recipientId
 */
async function loadWhatsappRecipientDestinationById(supabase, sellerId, recipientId) {
  const id = String(recipientId ?? "").trim();
  if (!id) return null;
  const { data } = await supabase
    .from("s7_notification_recipients")
    .select("destination, channel, is_active")
    .eq("id", id)
    .eq("seller_id", sellerId)
    .eq("channel", S7_NOTIFICATION_CHANNEL.WHATSAPP)
    .maybeSingle();
  if (!data?.is_active || !data.destination) return null;
  return String(data.destination);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} dispatchId

 * @param {string} channel

 */

async function loadOutboxByDispatch(supabase, dispatchId, channel) {

  if (!dispatchId) return null;

  const table =

    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP

      ? "s7_notification_whatsapp_outbox"

      : "s7_notification_email_outbox";

  const { data } = await supabase

    .from(table)

    .select("id, status, provider_message_id, attempts, last_error, metadata")

    .eq("dispatch_id", dispatchId)

    .maybeSingle();

  return data;

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} sellerId

 * @param {string} idempotencyKey

 */

async function loadIdempotentManualContext(supabase, sellerId, idempotencyKey) {

  const { data: event } = await supabase

    .from("s7_notification_events")

    .select("id, correlation_id")

    .eq("seller_id", sellerId)

    .eq("idempotency_key", idempotencyKey)

    .maybeSingle();

  if (!event?.id) return null;



  const { data: dispatches } = await supabase

    .from("s7_notification_dispatches")

    .select("id, status, channel")

    .eq("event_id", event.id);



  return { event, dispatches: dispatches ?? [] };

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {{

 *   sellerId: string;

 *   saleId: string;

 *   channel: string;

 *   recipientId?: string | null;

 *   recipientPhone?: string | null;

 *   recipientEmail?: string | null;

 *   useSmokeDestination?: boolean;

 *   smokeDestination?: boolean;

 *   shareImageBase64?: string | null;

 *   shareCaption?: string | null;

 *   deliveryFormat?: string | null;

 *   shareCacheKey?: string | null;

 * }} input
 */

export async function triggerManualSaleRayxNotification(supabase, input) {

  const routeStarted = Date.now();

  let loadSaleMs = 0;

  let enqueueMs = 0;

  let providerMs = 0;



  const sellerId = String(input.sellerId ?? "").trim();

  const saleId = String(input.saleId ?? "").trim();

  const channel = String(input.channel ?? "").trim().toLowerCase();



  if (!sellerId || !saleId) {

    return { ok: false, success: false, error: "INVALID_INPUT", duration_ms: Date.now() - routeStarted };

  }

  if (channel !== S7_NOTIFICATION_CHANNEL.WHATSAPP && channel !== S7_NOTIFICATION_CHANNEL.EMAIL) {

    return { ok: false, success: false, error: "INVALID_CHANNEL", duration_ms: Date.now() - routeStarted };

  }



  const loadStarted = Date.now();

  const sale = await loadSaleOrderItemForSeller(supabase, sellerId, saleId);

  loadSaleMs = Date.now() - loadStarted;



  if (!sale.ok) {

    return {

      ok: false,

      success: false,

      error: sale.error ?? "SALE_NOT_FOUND",

      duration_ms: Date.now() - routeStarted,

      timing: { load_sale_ms: loadSaleMs },

    };

  }



  const originalRecipientPhone =
    input.recipientPhone != null ? normalizeManualRayxPhone(input.recipientPhone) : null;

  let recipientPhone = input.recipientPhone;
  let recipientEmail = input.recipientEmail;

  let liveDestinationSource = MANUAL_RAYX_LIVE_DESTINATION_SOURCE.UNRESOLVED;
  let smokeOverrideApplied = false;

  const smokeExplicit =
    isExplicitSmokeDestinationRequest(input.useSmokeDestination) ||
    isExplicitSmokeDestinationRequest(input.smokeDestination);

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && smokeExplicit) {
    const smokePhone = resolveExplicitSmokePhoneForSeller(sellerId);
    if (smokePhone) {
      recipientPhone = smokePhone;
      smokeOverrideApplied = true;
      liveDestinationSource = MANUAL_RAYX_LIVE_DESTINATION_SOURCE.SMOKE_EXPLICIT;
    }
  } else if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && originalRecipientPhone) {
    recipientPhone = originalRecipientPhone;
    liveDestinationSource = MANUAL_RAYX_LIVE_DESTINATION_SOURCE.RECIPIENT_BODY;
  }

  if (channel === S7_NOTIFICATION_CHANNEL.EMAIL && !recipientEmail) {

    const { data: profile } = await supabase

      .from("profiles")

      .select("email")

      .eq("id", sellerId)

      .maybeSingle();

    recipientEmail = profile?.email ?? null;

  }

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && !recipientPhone && input.recipientId) {

    const fromRecipientId = await loadWhatsappRecipientDestinationById(

      supabase,

      sellerId,

      String(input.recipientId)

    );

    if (fromRecipientId) {

      recipientPhone = fromRecipientId;

      liveDestinationSource = MANUAL_RAYX_LIVE_DESTINATION_SOURCE.RECIPIENT_ID;

    }

  }

  const whatsappLiveActive =

    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && isWhatsAppLiveDeliveryActive();

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && !recipientPhone && !whatsappLiveActive) {

    const { data: profile } = await supabase

      .from("profiles")

      .select("phone")

      .eq("id", sellerId)

      .maybeSingle();

    if (profile?.phone) {

      recipientPhone = profile.phone;

      liveDestinationSource = MANUAL_RAYX_LIVE_DESTINATION_SOURCE.SELLER_PROFILE;

    }

  }

  let dest = resolveManualDestination(channel, recipientPhone, recipientEmail);

  if (!dest.ok) {

    const resolved = await resolveCentralRecipients(supabase, {

      sellerId,

      category: S7_NOTIFICATION_CATEGORY.SALES,

      type: MANUAL_TYPE,

      channel,

      marketplaceAccountId: sale.marketplace_account_id,

    });

    const first = resolved.find((r) => r.destination);

    if (first?.destination) {

      dest =

        channel === S7_NOTIFICATION_CHANNEL.WHATSAPP

          ? resolveManualDestination(channel, first.destination, null)

          : resolveManualDestination(channel, null, first.destination);

      if (dest.ok && channel === S7_NOTIFICATION_CHANNEL.WHATSAPP) {

        liveDestinationSource = MANUAL_RAYX_LIVE_DESTINATION_SOURCE.CENTRAL_RECIPIENT;

      }

    }

  }

  if (!dest.ok) {

    const failTrace =

      channel === S7_NOTIFICATION_CHANNEL.WHATSAPP

        ? buildManualRayxDestinationTrace({

            originalRecipientPhone: originalRecipientPhone || null,

            normalizedDestinationPhone: null,

            smokeEnabled: isProviderSmokeEnabled(),

            smokeOverrideApplied,

            liveDestinationSource,

          })

        : null;

    return {

      ok: false,

      success: false,

      error: dest.error,

      ...(failTrace ? failTrace : {}),

      duration_ms: Date.now() - routeStarted,

      timing: { load_sale_ms: loadSaleMs },

    };

  }

  if (

    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP &&

    liveDestinationSource === MANUAL_RAYX_LIVE_DESTINATION_SOURCE.UNRESOLVED

  ) {

    liveDestinationSource = originalRecipientPhone

      ? MANUAL_RAYX_LIVE_DESTINATION_SOURCE.RECIPIENT_BODY

      : MANUAL_RAYX_LIVE_DESTINATION_SOURCE.CENTRAL_RECIPIENT;

  }

  const destinationTrace =

    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP

      ? buildManualRayxDestinationTrace({

          originalRecipientPhone: originalRecipientPhone || null,

          normalizedDestinationPhone: dest.destination,

          smokeEnabled: isProviderSmokeEnabled(),

          smokeOverrideApplied,

          liveDestinationSource,

        })

      : null;



  const bucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);

  const correlationId = `sale-rayx.manual.${saleId}.${channel}.${bucket}`;

  const recipientKey =
    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP
      ? normalizeManualRayxPhone(input.recipientPhone) ||
        String(input.recipientId ?? "").trim() ||
        "unknown"
      : String(input.recipientEmail ?? input.recipientId ?? "unknown")
          .trim()
          .toLowerCase() || "unknown";

  const idempotencyKey = `manual.sale-rayx:${saleId}:${channel}:${recipientKey}:${bucket}`;



  logNotificationActions("MANUAL_SALE_RAYX_START", {

    seller_id: sellerId,

    sale_id: saleId,

    channel,

    correlation_id: correlationId,

    ...(destinationTrace ?? {}),

  });



  const enqueueStarted = Date.now();

  const pub = await publishNotificationEvent(supabase, {

    seller_id: sellerId,

    category: S7_NOTIFICATION_CATEGORY.SALES,

    type: MANUAL_TYPE,

    correlation_id: correlationId,

    idempotency_key: idempotencyKey,

    payload: sale.notificationPayload,

    entity_type: "sale_order_item",

    entity_id: saleId,

    marketplace_account_id: sale.marketplace_account_id,

    source_module: "sale_rayx_modal",

    force_redispatch: false,

    dispatch_options: {

      channels_filter: [channel],

      manual_recipients_by_channel: {

        [channel]: {

          destination: dest.destination,

          recipient_id: input.recipientId ?? null,

        },

      },

    },

  });

  enqueueMs = Date.now() - enqueueStarted;



  if (!pub.ok) {

    return {

      ok: false,

      success: false,

      error: pub.error ?? "PUBLISH_FAILED",

      correlation_id: correlationId,

      duration_ms: Date.now() - routeStarted,

      timing: { load_sale_ms: loadSaleMs, enqueue_ms: enqueueMs },

    };

  }



  if (pub.dispatches?.skipped_engine && pub.idempotent) {

    const ctx = await loadIdempotentManualContext(supabase, sellerId, idempotencyKey);

    const channelDispatch = ctx?.dispatches?.find((d) => d.channel === channel);

    const ob = channelDispatch?.id

      ? await loadOutboxByDispatch(supabase, String(channelDispatch.id), channel)

      : null;



    return {

      ok: true,

      success: true,

      status: ob?.status === "sent" ? "sent" : "skipped",

      skipped: true,

      idempotent: true,

      event_id: ctx?.event?.id ?? pub.event?.id ?? null,

      correlation_id: correlationId,

      dispatch_id: channelDispatch?.id ?? null,

      outbox_id: ob?.id ?? null,

      outbox_status: ob?.status ?? null,

      outbox_status_before: ob?.status ?? null,

      outbox_status_after: ob?.status ?? null,

      provider_message_id: ob?.provider_message_id ?? null,

      attempts: ob?.attempts ?? null,

      message: "Already triggered recently for this sale and channel",

      mocked: channel === S7_NOTIFICATION_CHANNEL.WHATSAPP ? !isWhatsAppLiveDeliveryActive() : !isRealEmailProviderConfigured(),

      real_send_executed: ob?.status === "sent" && !(ob?.metadata && typeof ob.metadata === "object" && ob.metadata.simulated),
      live_process_reason: "IDEMPOTENT_SKIP",
      live_audit: auditManualSaleRayxWhatsAppLive({
        sellerId,
        destinationPhone: dest.destination,
        liveDestinationSource,
        smokeOverrideApplied,
        destinationTrace,
      }),
      resolved_destination_phone: dest.destination,
      process_outbox_called: false,
      smoke_override_applied: smokeOverrideApplied,
      controlled_smoke_phone_used: smokeOverrideApplied,
      ...(destinationTrace ?? {}),
      duration_ms: Date.now() - routeStarted,
      timing: { load_sale_ms: loadSaleMs, enqueue_ms: enqueueMs, provider_ms: 0 },
    };
  }



  const channelDispatch = (pub.dispatches?.dispatches ?? []).find((d) => d.channel === channel);

  const dispatchId = channelDispatch?.dispatchId ?? null;

  const dispatchStatus = channelDispatch?.status ?? null;



  let outbox = dispatchId ? await loadOutboxByDispatch(supabase, dispatchId, channel) : null;

  const outboxStatusBefore = outbox?.status ?? null;



  let realSendExecuted = false;
  let liveProcessReason = null;
  let processOutboxCalled = false;
  let livePolicyApplied = false;
  let sandboxWhitelistApplied = false;
  let whitelistBypassReason = null;

  const liveSendPolicyPre =
    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP
      ? evaluateManualRayxLiveSendPolicy({
          destinationPhone: dest.destination,
          liveDestinationSource,
          smokeOverrideApplied,
        })
      : null;

  if (liveSendPolicyPre) {
    livePolicyApplied = liveSendPolicyPre.live_policy_applied === true;
    sandboxWhitelistApplied = liveSendPolicyPre.sandbox_whitelist_applied === true;
    whitelistBypassReason = liveSendPolicyPre.whitelist_bypass_reason ?? null;
  }

  const destinationTraceFinal =
    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP
      ? buildManualRayxDestinationTrace({
          originalRecipientPhone: originalRecipientPhone || null,
          normalizedDestinationPhone: dest.destination,
          smokeEnabled: isProviderSmokeEnabled(),
          smokeOverrideApplied,
          liveDestinationSource,
          livePolicyApplied,
          sandboxWhitelistApplied,
          whitelistBypassReason,
        })
      : null;

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && dispatchId && destinationTraceFinal) {
    await patchManualRayxWhatsAppOutboxPolicy(
      supabase,
      dispatchId,
      buildManualRayxOutboxPolicyMetadata({
        originalRecipientPhone: originalRecipientPhone || null,
        normalizedDestinationPhone: dest.destination,
        smokeEnabled: isProviderSmokeEnabled(),
        smokeOverrideApplied,
        liveDestinationSource,
        livePolicyApplied,
        sandboxWhitelistApplied,
        whitelistBypassReason,
      })
    );
  }

  const shareImageBase64 =
    input.shareImageBase64 != null ? String(input.shareImageBase64).trim() : "";
  const shareCaption =
    input.shareCaption != null ? String(input.shareCaption).trim() : "";
  const deliveryFormat =
    input.deliveryFormat != null ? String(input.deliveryFormat).trim() : "text";

  if (
    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP &&
    dispatchId &&
    deliveryFormat === "image" &&
    shareImageBase64
  ) {
    await patchManualRayxWhatsAppOutboxShare(supabase, dispatchId, {
      caption: shareCaption,
      imageBase64: shareImageBase64,
      mimeType: "image/png",
      deliveryFormat: "image",
      shareCacheKey: input.shareCacheKey ?? null,
    });
    outbox = await loadOutboxByDispatch(supabase, dispatchId, channel);
  }

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && dispatchId) {
    const liveDecision = canProcessManualSaleRayxWhatsAppLive({
      sellerId,
      destinationPhone: dest.destination,
      liveDestinationSource,
      smokeOverrideApplied,
    });

    livePolicyApplied = liveDecision.live_policy_applied === true;
    sandboxWhitelistApplied = liveDecision.sandbox_whitelist_applied === true;
    whitelistBypassReason = liveDecision.whitelist_bypass_reason ?? null;

    if (liveDecision.process) {
      processOutboxCalled = true;
      const processResult = await processWhatsAppOutboxDispatch(supabase, dispatchId);

      providerMs = processResult.duration_ms ?? 0;

      outbox = await loadOutboxByDispatch(supabase, dispatchId, channel);

      realSendExecuted =

        processResult.sent === 1 &&

        outbox?.status === "sent" &&

        Boolean(outbox?.provider_message_id) &&

        !processResult.simulated;

      liveProcessReason = "LIVE_DISPATCH_PROCESSED";

    } else {

      liveProcessReason = liveDecision.reason ?? "ENQUEUE_ONLY";

    }

  }

  const liveAudit = auditManualSaleRayxWhatsAppLive({

    sellerId,

    destinationPhone: dest.destination,

    liveDestinationSource,

    smokeOverrideApplied,

    destinationTrace: destinationTraceFinal,

  });



  const outboxStatusAfter = outbox?.status ?? null;

  const queued =

    dispatchStatus === S7_NOTIFICATION_DISPATCH_STATUS.QUEUED ||

    outboxStatusAfter === "pending";

  const mocked =

    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP

      ? !isWhatsAppLiveDeliveryActive() || !realSendExecuted

      : !isRealEmailProviderConfigured();



  let status = "queued";

  if (realSendExecuted) status = "sent";

  else if (outboxStatusAfter === "failed") status = "failed";

  else if (queued) status = "queued";



  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP) {
    recordRayxWhatsAppMotorObservability({
      route: "single",
      seller_id: sellerId,
      event_id: pub.event?.id ?? null,
      dispatch_id: dispatchId,
      outbox_id: outbox?.id ?? null,
      correlation_id: correlationId,
      status,
      channel,
      provider_key:
        realSendExecuted ? resolveWhatsAppProviderName() : mocked ? "s7_whatsapp_mock" : resolveWhatsAppProviderName(),
      provider_message_id: outbox?.provider_message_id ?? null,
      real_send_executed: realSendExecuted,
      live_process_reason: liveProcessReason,
    });
  }

  logNotificationActions("MANUAL_SALE_RAYX_COMPLETE", {

    seller_id: sellerId,

    sale_id: saleId,

    channel,

    event_id: pub.event?.id,

    dispatch_id: dispatchId,

    outbox_id: outbox?.id,

    status,

    mocked,

    real_send_executed: realSendExecuted,

    live_process_reason: liveProcessReason,

    process_outbox_called: processOutboxCalled,

    live_policy_applied: livePolicyApplied,

    sandbox_whitelist_applied: sandboxWhitelistApplied,

    whitelist_bypass_reason: whitelistBypassReason,

    ...(destinationTraceFinal ?? {}),

    duration_ms: Date.now() - routeStarted,

  });



  return {

    ok: true,

    success: true,

    status,

    queued: status === "queued",

    mocked,

    skipped: false,

    idempotent: Boolean(pub.idempotent),

    event_id: pub.event?.id ?? null,

    correlation_id: correlationId,

    dispatch_id: dispatchId,

    outbox_id: outbox?.id ?? null,

    outbox_status: outboxStatusAfter,

    outbox_status_before: outboxStatusBefore,

    outbox_status_after: outboxStatusAfter,

    provider_message_id: outbox?.provider_message_id ?? null,

    attempts: outbox?.attempts ?? null,

    last_error: outbox?.last_error ?? null,

    provider_key:

      channel === S7_NOTIFICATION_CHANNEL.WHATSAPP

        ? realSendExecuted

          ? resolveWhatsAppProviderName()

          : mocked

            ? "s7_whatsapp_mock"

            : resolveWhatsAppProviderName()

        : mocked

          ? "s7_email_mock"

          : "s7_email_live",

    real_send_executed: realSendExecuted,
    live_process_reason: liveProcessReason,
    live_audit: liveAudit,
    resolved_destination_phone: dest.destination,
    process_outbox_called: processOutboxCalled,
    smoke_override_applied: smokeOverrideApplied,
    controlled_smoke_phone_used: smokeOverrideApplied,
    live_policy_applied: livePolicyApplied,
    sandbox_whitelist_applied: sandboxWhitelistApplied,
    whitelist_bypass_reason: whitelistBypassReason,
    ...(destinationTraceFinal ?? {}),
    duration_ms: Date.now() - routeStarted,
    timing: {
      load_sale_ms: loadSaleMs,
      enqueue_ms: enqueueMs,
      provider_ms: providerMs,
      total_ms: Date.now() - routeStarted,
    },
  };
}

/**
 * Acionamento manual para múltiplos destinatários WhatsApp (um dispatch/outbox por destino).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   saleId: string;
 *   channel: string;
 *   recipientTargets?: Array<{ recipientId?: string | null; recipientPhone: string }>;
 *   useSmokeDestination?: boolean;
 *   smokeDestination?: boolean;
 *   recipientEmail?: string | null;
 *   shareImageBase64?: string | null;
 *   shareCaption?: string | null;
 *   deliveryFormat?: string | null;
 *   shareCacheKey?: string | null;
 * }} input
 */
export async function triggerManualSaleRayxNotificationsBatch(supabase, input) {
  const rawTargets = Array.isArray(input.recipientTargets) ? input.recipientTargets : [];
  if (rawTargets.length === 0) {
    return triggerManualSaleRayxNotification(supabase, input);
  }

  const dedupe = dedupeOfficialWhatsAppRecipients(rawTargets, {
    saleId: input.saleId,
    channel: input.channel,
    useSmokeDestination: input.useSmokeDestination ?? input.smokeDestination,
  });
  const targets = dedupe.final_recipient_targets;

  if (targets.length === 0) {
    return {
      ok: false,
      success: false,
      error: "NO_VALID_RECIPIENTS",
      multi: true,
      ...dedupe,
    };
  }

  const selectedRecipientIds = [];
  const selectedRecipientPhones = [];
  /** @type {Array<Record<string, unknown>>} */
  const results = [];

  for (const target of targets) {
    const phone = normalizeManualRayxPhone(target.recipientPhone);
    if (!phone) continue;

    const one = await triggerManualSaleRayxNotification(supabase, {
      sellerId: input.sellerId,
      saleId: input.saleId,
      channel: input.channel,
      recipientId: target.recipientId ?? null,
      recipientPhone: phone,
      recipientEmail: input.recipientEmail ?? null,
      useSmokeDestination: input.useSmokeDestination,
      smokeDestination: input.smokeDestination,
      shareImageBase64: input.shareImageBase64 ?? null,
      shareCaption: input.shareCaption ?? null,
      deliveryFormat: input.deliveryFormat ?? null,
      shareCacheKey: input.shareCacheKey ?? null,
    });

    results.push(one);
    if (target.recipientId) selectedRecipientIds.push(String(target.recipientId));
    selectedRecipientPhones.push(phone);
  }

  if (results.length === 0) {
    return { ok: false, success: false, error: "INVALID_PHONE", multi: true };
  }

  const allOk = results.every((r) => r.ok === true);
  const allSent = results.every((r) => r.real_send_executed === true);
  const anySent = results.some((r) => r.real_send_executed === true);
  const last = results[results.length - 1];

  const dispatchesCreated = results.filter((r) => r.dispatch_id).length;

  if (input.channel === S7_NOTIFICATION_CHANNEL.WHATSAPP) {
    recordRayxWhatsAppMotorObservability({
      route: "batch",
      multi: true,
      seller_id: input.sellerId,
      event_id: last?.event_id ?? null,
      dispatch_id: last?.dispatch_id ?? null,
      outbox_id: last?.outbox_id ?? null,
      correlation_id: last?.correlation_id ?? null,
      status: allSent ? "sent" : anySent ? "partial" : last?.status ?? "queued",
      channel: input.channel,
      provider_key: last?.provider_key ?? null,
      provider_message_id: last?.provider_message_id ?? null,
      real_send_executed: allSent,
      live_process_reason: allSent ? "LIVE_DISPATCH_PROCESSED" : last?.live_process_reason ?? null,
      dispatches_created: dispatchesCreated,
    });
  }

  logNotificationActions("MANUAL_SALE_RAYX_BATCH_COMPLETE", {
    seller_id: input.sellerId,
    sale_id: input.saleId,
    channel: input.channel,
    selected_targets_source: "client_recipient_targets",
    selected_recipient_ids_raw: dedupe.selected_recipient_ids_raw,
    selected_recipient_phones_raw: dedupe.selected_recipient_phones_raw,
    selected_recipient_phones_normalized: dedupe.selected_recipient_phones_normalized,
    duplicate_recipients_removed: dedupe.duplicate_recipients_removed,
    final_recipient_targets: dedupe.final_recipient_targets,
    selected_recipient_ids: selectedRecipientIds,
    selected_recipient_phones: selectedRecipientPhones,
    dispatches_created: dispatchesCreated,
    results_count: results.length,
    all_sent: allSent,
  });

  return {
    ...last,
    ok: allOk,
    success: allOk,
    multi: true,
    status: allSent ? "sent" : anySent ? "partial" : last.status ?? "queued",
    real_send_executed: allSent,
    selected_recipient_ids_raw: dedupe.selected_recipient_ids_raw,
    selected_recipient_phones_raw: dedupe.selected_recipient_phones_raw,
    selected_recipient_phones_normalized: dedupe.selected_recipient_phones_normalized,
    duplicate_recipients_removed: dedupe.duplicate_recipients_removed,
    final_recipient_targets: dedupe.final_recipient_targets.map((t) => t.recipientPhone),
    selected_recipient_ids: selectedRecipientIds,
    selected_recipient_phones: selectedRecipientPhones,
    dispatches_created: dispatchesCreated,
    results,
    mocked: results.some((r) => r.mocked === true),
    process_outbox_called: results.some((r) => r.process_outbox_called === true),
    live_process_reason: allSent
      ? "LIVE_DISPATCH_PROCESSED"
      : results.map((r) => r.live_process_reason).filter(Boolean).join("|") || last.live_process_reason,
  };
}


