// =============================================================================
// Acionamento manual — Relatório de Concorrência → Motor Central
// Espelha MANUAL_SALES_REPORT + canal E-mail do MANUAL_SALE_RAYX.
// =============================================================================

import { S7_NOTIFICATION_CATEGORY } from "../constants/categories.js";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { S7_NOTIFICATION_DISPATCH_STATUS } from "../constants/dispatchStatus.js";
import { publishNotificationEvent } from "../events/publishNotificationEvent.js";
import { isWhatsAppLiveDeliveryActive } from "../whatsapp/S7WhatsAppProvider.js";
import { isRealEmailProviderConfigured } from "../email/S7EmailProvider.js";
import { logNotificationActions } from "../actions/notificationActionsLog.js";
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
  resolveExplicitSmokePhoneForSeller,
} from "../sales/manualSaleRayxLiveDelivery.js";
import { dedupeOfficialWhatsAppRecipients } from "../whatsapp/index.js";
import { recordRayxWhatsAppMotorObservability } from "../sales/rayxWhatsAppMotorObservability.js";
import { isProviderSmokeEnabled } from "../providers/abstraction/providerSmokePolicy.js";
import { processWhatsAppOutboxDispatch } from "../whatsapp/processWhatsAppOutboxDispatch.js";
import { processEmailOutbox } from "../email/processEmailOutbox.js";
import { resolveWhatsAppProviderName } from "../providers/whatsapp/whatsappProviderEnv.js";
import { renderCompetitionManualEmailBody } from "./renderCompetitionManualEmailBody.js";
import { patchManualRayxWhatsAppOutboxShare } from "../sales/manualSaleRayxLiveDelivery.js";
import { patchCompetitionReportEmailOutboxShare } from "./competitionReportOutboxShare.js";

const MANUAL_TYPE = "MANUAL_COMPETITION_REPORT";
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
 * @param {string} sellerId
 * @param {string} recipientId
 */
async function loadEmailRecipientDestinationById(supabase, sellerId, recipientId) {
  const id = String(recipientId ?? "").trim();
  if (!id) return null;
  const { data } = await supabase
    .from("s7_notification_recipients")
    .select("destination, channel, is_active")
    .eq("id", id)
    .eq("seller_id", sellerId)
    .eq("channel", S7_NOTIFICATION_CHANNEL.EMAIL)
    .maybeSingle();
  if (!data?.is_active || !data.destination) return null;
  return String(data.destination);
}

/**
 * @param {Record<string, unknown> | null | undefined} raw
 */
function normalizeTemplatePayload(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    conta: String(src.conta ?? "—").trim() || "—",
    filtro: String(src.filtro ?? "—").trim() || "—",
    produtos: String(src.produtos ?? "—").trim() || "—",
    comConcorrentes: String(src.comConcorrentes ?? "—").trim() || "—",
    totalConcorrentes: String(src.totalConcorrentes ?? "—").trim() || "—",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   reportKey: string;
 *   channel: string;
 *   recipientId?: string | null;
 *   recipientPhone?: string | null;
 *   recipientEmail?: string | null;
 *   recipientName?: string | null;
 *   templatePayload?: Record<string, unknown> | null;
 *   useSmokeDestination?: boolean;
 *   shareCaption?: string | null;
 *   shareImageBase64?: string | null;
 *   shareDocumentBase64?: string | null;
 *   shareDocumentFilename?: string | null;
 *   shareDocumentMimeType?: string | null;
 *   shareTextFallback?: string | null;
 *   deliveryFormat?: string | null;
 * }} input
 */
export async function triggerManualCompetitionReportNotification(supabase, input) {
  const routeStarted = Date.now();
  const sellerId = String(input.sellerId ?? "").trim();
  const reportKey = String(input.reportKey ?? "").trim();
  const channel = String(input.channel ?? "").trim().toLowerCase();

  if (!sellerId || !reportKey) {
    return { ok: false, success: false, error: "INVALID_INPUT", duration_ms: Date.now() - routeStarted };
  }
  if (channel !== S7_NOTIFICATION_CHANNEL.WHATSAPP && channel !== S7_NOTIFICATION_CHANNEL.EMAIL) {
    return { ok: false, success: false, error: "INVALID_CHANNEL", duration_ms: Date.now() - routeStarted };
  }

  const templatePayload = normalizeTemplatePayload(input.templatePayload);
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
      String(input.recipientId),
    );
    if (fromRecipientId) {
      recipientPhone = fromRecipientId;
      liveDestinationSource = MANUAL_RAYX_LIVE_DESTINATION_SOURCE.RECIPIENT_ID;
    }
  }

  if (channel === S7_NOTIFICATION_CHANNEL.EMAIL && !recipientEmail && input.recipientId) {
    const fromRecipientId = await loadEmailRecipientDestinationById(
      supabase,
      sellerId,
      String(input.recipientId),
    );
    if (fromRecipientId) {
      recipientEmail = fromRecipientId;
    }
  }

  const dest = resolveManualDestination(channel, recipientPhone, recipientEmail);
  if (!dest.ok) {
    return {
      ok: false,
      success: false,
      error: dest.error,
      duration_ms: Date.now() - routeStarted,
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
  const correlationId = `competition-report.manual.${reportKey}.${channel}.${bucket}`;
  const recipientKey =
    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP
      ? normalizeManualRayxPhone(input.recipientPhone) ||
        String(input.recipientId ?? "").trim() ||
        "unknown"
      : String(input.recipientEmail ?? input.recipientId ?? "unknown")
          .trim()
          .toLowerCase() || "unknown";
  const idempotencyKey = `manual.competition-report:${reportKey}:${channel}:${recipientKey}:${bucket}`;

  logNotificationActions("MANUAL_COMPETITION_REPORT_START", {
    seller_id: sellerId,
    report_key: reportKey,
    channel,
    correlation_id: correlationId,
    ...(destinationTrace ?? {}),
  });

  const pub = await publishNotificationEvent(supabase, {
    seller_id: sellerId,
    category: S7_NOTIFICATION_CATEGORY.COMPETITION,
    type: MANUAL_TYPE,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    payload: templatePayload,
    entity_type: "competition_report_manual",
    entity_id: reportKey,
    source_module: "concorrencia_relatorio_modal",
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

  if (!pub.ok) {
    return {
      ok: false,
      success: false,
      error: pub.error ?? "PUBLISH_FAILED",
      correlation_id: correlationId,
      duration_ms: Date.now() - routeStarted,
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

  const shareImageBase64 =
    input.shareImageBase64 != null ? String(input.shareImageBase64).trim() : "";
  const shareDocumentBase64 =
    input.shareDocumentBase64 != null ? String(input.shareDocumentBase64).trim() : "";
  const shareCaption = input.shareCaption != null ? String(input.shareCaption).trim() : "";
  const shareTextFallback =
    input.shareTextFallback != null ? String(input.shareTextFallback).trim() : "";
  const deliveryFormat =
    input.deliveryFormat != null
      ? String(input.deliveryFormat).trim()
      : shareImageBase64
        ? "image"
        : "text";

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP && dispatchId && destinationTrace) {
    const liveSendPolicyPre = evaluateManualRayxLiveSendPolicy({
      destinationPhone: dest.destination,
      liveDestinationSource,
      smokeOverrideApplied,
    });
    livePolicyApplied = liveSendPolicyPre.live_policy_applied === true;
    sandboxWhitelistApplied = liveSendPolicyPre.sandbox_whitelist_applied === true;
    whitelistBypassReason = liveSendPolicyPre.whitelist_bypass_reason ?? null;

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
      }),
    );

    if (deliveryFormat === "image" && shareImageBase64) {
      await patchManualRayxWhatsAppOutboxShare(supabase, dispatchId, {
        caption: "",
        imageBase64: shareImageBase64,
        mimeType: "image/png",
        deliveryFormat: "image",
        documentBase64: shareDocumentBase64 || null,
        documentFilename: input.shareDocumentFilename ?? null,
        documentMimeType: input.shareDocumentMimeType ?? null,
      });

      await supabase
        .from("s7_notification_whatsapp_outbox")
        .update({
          message_text: "",
          updated_at: new Date().toISOString(),
        })
        .eq("dispatch_id", dispatchId);

      outbox = await loadOutboxByDispatch(supabase, dispatchId, channel);
    }

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

  if (channel === S7_NOTIFICATION_CHANNEL.EMAIL && dispatchId) {
    const imageMimeType = "image/png";
    const imageDataUri = shareImageBase64
      ? shareImageBase64.startsWith("data:")
        ? shareImageBase64
        : `data:${imageMimeType};base64,${shareImageBase64}`
      : "";

    const rendered = renderCompetitionManualEmailBody({
      recipientName: input.recipientName ?? null,
    });

    await patchCompetitionReportEmailOutboxShare(supabase, dispatchId, {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      imageDataUri: imageDataUri || null,
      imageFilename: input.shareImageFilename ?? null,
      documentBase64: shareDocumentBase64 || null,
      documentFilename: input.shareDocumentFilename ?? null,
      documentMimeType: input.shareDocumentMimeType ?? null,
    });
    outbox = await loadOutboxByDispatch(supabase, dispatchId, channel);

    processOutboxCalled = true;
    const processResult = await processEmailOutbox(supabase, { dispatchId });
    outbox = await loadOutboxByDispatch(supabase, dispatchId, channel);
    realSendExecuted =
      (processResult?.sent ?? 0) >= 1 &&
      outbox?.status === "sent" &&
      Boolean(outbox?.provider_message_id);
    liveProcessReason = realSendExecuted ? "LIVE_DISPATCH_PROCESSED" : "ENQUEUE_ONLY";
  }

  const outboxStatusAfter = outbox?.status ?? null;
  const queued =
    dispatchStatus === S7_NOTIFICATION_DISPATCH_STATUS.QUEUED || outboxStatusAfter === "pending";
  const mocked =
    channel === S7_NOTIFICATION_CHANNEL.WHATSAPP
      ? !isWhatsAppLiveDeliveryActive() || !realSendExecuted
      : !isRealEmailProviderConfigured() || !realSendExecuted;

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
      provider_key: realSendExecuted ? resolveWhatsAppProviderName() : mocked ? "s7_whatsapp_mock" : resolveWhatsAppProviderName(),
      provider_message_id: outbox?.provider_message_id ?? null,
      real_send_executed: realSendExecuted,
      live_process_reason: liveProcessReason,
    });
  }

  logNotificationActions("MANUAL_COMPETITION_REPORT_COMPLETE", {
    seller_id: sellerId,
    report_key: reportKey,
    channel,
    event_id: pub.event?.id,
    dispatch_id: dispatchId,
    outbox_id: outbox?.id,
    status,
    mocked,
    real_send_executed: realSendExecuted,
    live_process_reason: liveProcessReason,
    process_outbox_called: processOutboxCalled,
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
    provider_key:
      channel === S7_NOTIFICATION_CHANNEL.WHATSAPP
        ? realSendExecuted
          ? resolveWhatsAppProviderName()
          : mocked
            ? "s7_whatsapp_mock"
            : resolveWhatsAppProviderName()
        : null,
    real_send_executed: realSendExecuted,
    live_process_reason: liveProcessReason,
    process_outbox_called: processOutboxCalled,
    live_policy_applied: livePolicyApplied,
    sandbox_whitelist_applied: sandboxWhitelistApplied,
    whitelist_bypass_reason: whitelistBypassReason,
    resolved_destination_phone:
      channel === S7_NOTIFICATION_CHANNEL.WHATSAPP ? dest.destination : null,
    resolved_destination_email:
      channel === S7_NOTIFICATION_CHANNEL.EMAIL ? dest.destination : null,
    live_audit:
      channel === S7_NOTIFICATION_CHANNEL.WHATSAPP
        ? auditManualSaleRayxWhatsAppLive({
            sellerId,
            destinationPhone: dest.destination,
            liveDestinationSource,
            smokeOverrideApplied,
            destinationTrace,
          })
        : null,
    ...(destinationTrace ?? {}),
    duration_ms: Date.now() - routeStarted,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   reportKey: string;
 *   channel: string;
 *   recipientTargets?: Array<{
 *     recipientId?: string | null;
 *     recipientPhone?: string;
 *     recipientEmail?: string;
 *     recipientName?: string | null;
 *   }>;
 *   templatePayload?: Record<string, unknown> | null;
 *   useSmokeDestination?: boolean;
 *   shareCaption?: string | null;
 *   shareImageBase64?: string | null;
 *   shareDocumentBase64?: string | null;
 *   shareDocumentFilename?: string | null;
 *   shareDocumentMimeType?: string | null;
 *   shareTextFallback?: string | null;
 *   deliveryFormat?: string | null;
 * }} input
 */
export async function triggerManualCompetitionReportNotificationsBatch(supabase, input) {
  const channel = String(input.channel ?? "").trim().toLowerCase();
  const rawTargets = Array.isArray(input.recipientTargets) ? input.recipientTargets : [];

  if (rawTargets.length === 0) {
    return triggerManualCompetitionReportNotification(supabase, input);
  }

  let targets = rawTargets;

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP) {
    const dedupe = dedupeOfficialWhatsAppRecipients(
      rawTargets.map((t) => ({
        recipientId: t.recipientId ?? null,
        recipientPhone: t.recipientPhone,
      })),
      {
        saleId: input.reportKey,
        channel,
        useSmokeDestination: input.useSmokeDestination,
      },
    );
    targets = dedupe.final_recipient_targets;
    if (targets.length === 0) {
      return { ok: false, success: false, error: "NO_VALID_RECIPIENTS", multi: true, ...dedupe };
    }
  } else if (channel === S7_NOTIFICATION_CHANNEL.EMAIL) {
    const byEmail = new Map();
    for (const t of rawTargets) {
      const email = String(t.recipientEmail ?? "")
        .trim()
        .toLowerCase();
      if (!email || !email.includes("@")) continue;
      if (!byEmail.has(email)) {
        byEmail.set(email, {
          recipientId: t.recipientId ?? null,
          recipientEmail: email,
          recipientName: t.recipientName ?? null,
        });
      }
    }
    targets = [...byEmail.values()];
    if (targets.length === 0) {
      return { ok: false, success: false, error: "NO_VALID_RECIPIENTS", multi: true };
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const results = [];

  for (const target of targets) {
    const one = await triggerManualCompetitionReportNotification(supabase, {
      sellerId: input.sellerId,
      reportKey: input.reportKey,
      channel,
      recipientId: target.recipientId ?? null,
      recipientPhone:
        channel === S7_NOTIFICATION_CHANNEL.WHATSAPP ? target.recipientPhone : null,
      recipientEmail:
        channel === S7_NOTIFICATION_CHANNEL.EMAIL ? target.recipientEmail : null,
      recipientName: target.recipientName ?? null,
      templatePayload: input.templatePayload,
      useSmokeDestination: input.useSmokeDestination,
      shareCaption: input.shareCaption ?? null,
      shareImageBase64: input.shareImageBase64 ?? null,
      shareDocumentBase64: input.shareDocumentBase64 ?? null,
      shareDocumentFilename: input.shareDocumentFilename ?? null,
      shareDocumentMimeType: input.shareDocumentMimeType ?? null,
      shareTextFallback: input.shareTextFallback ?? null,
      deliveryFormat: input.deliveryFormat ?? null,
    });
    results.push(one);
  }

  if (results.length === 0) {
    return { ok: false, success: false, error: "INVALID_RECIPIENTS", multi: true };
  }

  const allOk = results.every((r) => r.ok === true);
  const allSent = results.every((r) => r.real_send_executed === true);
  const anySent = results.some((r) => r.real_send_executed === true);
  const last = results[results.length - 1];
  const dispatchesCreated = results.filter((r) => r.dispatch_id).length;

  if (channel === S7_NOTIFICATION_CHANNEL.WHATSAPP) {
    recordRayxWhatsAppMotorObservability({
      route: "batch",
      multi: true,
      seller_id: input.sellerId,
      event_id: last?.event_id ?? null,
      dispatch_id: last?.dispatch_id ?? null,
      outbox_id: last?.outbox_id ?? null,
      correlation_id: last?.correlation_id ?? null,
      status: allSent ? "sent" : anySent ? "partial" : last?.status ?? "queued",
      channel,
      provider_key: last?.provider_key ?? null,
      provider_message_id: last?.provider_message_id ?? null,
      real_send_executed: allSent,
      live_process_reason: allSent ? "LIVE_DISPATCH_PROCESSED" : last?.live_process_reason ?? null,
      dispatches_created: dispatchesCreated,
    });
  }

  return {
    ...last,
    ok: allOk,
    success: allOk,
    multi: true,
    status: allSent ? "sent" : anySent ? "partial" : last.status ?? "queued",
    real_send_executed: allSent,
    dispatches_created: dispatchesCreated,
    results,
    mocked: results.some((r) => r.mocked === true),
    process_outbox_called: results.some((r) => r.process_outbox_called === true),
    live_process_reason: allSent
      ? "LIVE_DISPATCH_PROCESSED"
      : results.map((r) => r.live_process_reason).filter(Boolean).join("|") || last.live_process_reason,
  };
}
