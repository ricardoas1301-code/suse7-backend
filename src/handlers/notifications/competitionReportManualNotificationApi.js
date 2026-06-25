// =============================================================================
// POST /api/notifications/manual/competition-report — Relatório de Concorrência
// Espelha salesReportManualNotificationApi.js (WhatsApp + E-mail).
// =============================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  triggerManualCompetitionReportNotification,
  triggerManualCompetitionReportNotificationsBatch,
} from "../../domain/notifications/central/competition/triggerManualCompetitionReportNotification.js";
import { dedupeOfficialWhatsAppRecipients } from "../../domain/notifications/central/whatsapp/index.js";
import { logNotificationActions } from "../../domain/notifications/central/actions/notificationActionsLog.js";
import {
  auditManualSaleRayxWhatsAppLive,
  getManualSaleRayxRuntimeEnvSnapshot,
  isExplicitSmokeDestinationRequest,
} from "../../domain/notifications/central/sales/manualSaleRayxLiveDelivery.js";
import { isRealEmailProviderConfigured } from "../../domain/notifications/central/email/S7EmailProvider.js";
import { isRealWhatsAppProviderConfigured } from "../../domain/notifications/central/whatsapp/S7WhatsAppProvider.js";
import os from "node:os";

function buildBackendDebug(req) {
  const env = getManualSaleRayxRuntimeEnvSnapshot();
  const host = req.headers?.host != null ? String(req.headers.host) : "";
  const proto =
    req.headers["x-forwarded-proto"] != null
      ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
      : "http";
  const apiOrigin = host ? `${proto}://${host}` : null;

  return {
    api_origin: apiOrigin,
    backend_instance: process.env.VERCEL_URL
      ? `vercel:${String(process.env.VERCEL_URL)}`
      : `local:${os.hostname()}:${process.env.PORT ?? "3001"}`,
    process_pid: process.pid,
    node_env: process.env.NODE_ENV ?? null,
    s7_app_env: process.env.S7_APP_ENV ?? null,
    whatsapp_provider: env.whatsapp_provider,
    s7_whatsapp_mode: env.s7_whatsapp_mode,
    s7_allow_live_delivery: env.s7_allow_live_delivery,
    live_delivery_active: env.live_delivery_active,
  };
}

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return req.body.trim() ? JSON.parse(req.body) : {};
    } catch {
      return null;
    }
  }
  return typeof req.body === "object" ? req.body : {};
}

function jsonError(res, status, code, message) {
  return res.status(status).json({ ok: false, success: false, error: code, message });
}

function isDevRuntime() {
  const nodeEnv = String(process.env.NODE_ENV ?? "").trim().toLowerCase();
  const appEnv = String(process.env.S7_APP_ENV ?? "").trim().toLowerCase();
  return nodeEnv !== "production" || (appEnv !== "" && appEnv !== "prod" && appEnv !== "production");
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} channel
 */
function extractMissingManualPayloadFields(body, channel) {
  const missing = [];
  if (!String(body.report_key ?? "").trim()) missing.push("report_key");
  if (!String(channel ?? "").trim()) missing.push("channel");
  if (channel !== "whatsapp" && channel !== "email") missing.push("channel(valid: whatsapp|email)");

  const targets = Array.isArray(body.recipient_targets) ? body.recipient_targets : [];
  const hasSingleFallback =
    body.recipient_id != null ||
    body.recipient_phone != null ||
    body.recipient_email != null ||
    body.recipient_name != null;

  if (!hasSingleFallback && targets.length === 0) {
    missing.push("recipient_targets[]|recipient_id/recipient_phone/recipient_email");
  }

  if (channel === "whatsapp" && targets.length > 0) {
    const hasAnyPhone = targets.some((t) => String(t?.recipient_phone ?? "").replace(/\D/g, "").length >= 10);
    if (!hasAnyPhone) missing.push("recipient_targets[].recipient_phone(valid)");
  }

  if (channel === "email" && targets.length > 0) {
    const hasAnyEmail = targets.some((t) => String(t?.recipient_email ?? "").includes("@"));
    if (!hasAnyEmail) missing.push("recipient_targets[].recipient_email(valid)");
  }

  return missing;
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} channel
 * @param {string} reason
 */
function logManualCompetitionPayloadDebug(body, channel, reason) {
  if (!isDevRuntime()) return;
  const keysRecebidas = body && typeof body === "object" ? Object.keys(body).sort() : [];
  const camposAusentes = extractMissingManualPayloadFields(body, channel);
  const templatePayloadKeys =
    body?.template_payload && typeof body.template_payload === "object"
      ? Object.keys(/** @type {Record<string, unknown>} */ (body.template_payload)).sort()
      : [];
  const targetsCount = Array.isArray(body?.recipient_targets) ? body.recipient_targets.length : 0;
  console.info("[S7_COMPETITION_REPORT_MANUAL_PAYLOAD]", {
    channel,
    keys_recebidas: keysRecebidas,
    campos_ausentes: camposAusentes,
    motivo_exato_do_400: reason,
    ids_recebidos: {
      company_id: body?.company_id ?? null,
      profile_id: body?.profile_id ?? null,
      account_id: body?.account_id ?? null,
      user_id: body?.user_id ?? null,
    },
    payload_report: {
      report_key: body?.report_key ?? null,
      template_payload_keys: templatePayloadKeys,
      has_report_data: body?.report_data != null || body?.data != null || body?.items != null || body?.summary != null,
    },
    destinatarios: {
      recipient_targets_count: targetsCount,
      has_single_recipient_phone: body?.recipient_phone != null,
      has_single_recipient_email: body?.recipient_email != null,
    },
  });
}

/**
 * @param {Record<string, unknown>} result
 */
function classifyManualCompetitionFailure(result) {
  const code = String(result?.error ?? "").trim().toUpperCase();
  const isValidation =
    code === "INVALID_INPUT" ||
    code === "INVALID_CHANNEL" ||
    code === "INVALID_PHONE" ||
    code === "INVALID_EMAIL" ||
    code === "NO_VALID_RECIPIENTS" ||
    code === "INVALID_RECIPIENTS";

  if (isValidation) {
    return {
      status: 422,
      code: code || "MANUAL_COMPETITION_REPORT_VALIDATION_FAILED",
      failureType: "validation",
      message:
        code === "NO_VALID_RECIPIENTS"
          ? "Nenhum destinatário válido foi encontrado para o canal selecionado."
          : code === "INVALID_PHONE"
            ? "Destinatário de WhatsApp inválido ou não configurado."
            : code === "INVALID_EMAIL"
              ? "Destinatário de e-mail inválido ou não configurado."
              : "Falha de validação no envio manual do relatório.",
    };
  }

  return {
    status: 503,
    code: code || "MANUAL_COMPETITION_REPORT_DELIVERY_UNAVAILABLE",
    failureType: "delivery_configuration",
    message:
      "Falha de configuração/entrega do motor de notificação. Verifique provedores e regras do canal.",
  };
}

function buildManualCompetitionDeliveryConfigHint(channel) {
  const ch = String(channel ?? "").trim().toLowerCase();
  if (ch === "email") {
    const provider = String(process.env.S7_EMAIL_PROVIDER ?? "mock").trim().toLowerCase();
    return {
      channel: "email",
      provider,
      mode: String(process.env.S7_EMAIL_MODE ?? "mock").trim().toLowerCase(),
      real_provider_configured: isRealEmailProviderConfigured(),
      resend_api_key_present: String(process.env.RESEND_API_KEY ?? "").trim() !== "",
      sendgrid_api_key_present: String(process.env.SENDGRID_API_KEY ?? "").trim() !== "",
    };
  }

  if (ch === "whatsapp") {
    return {
      channel: "whatsapp",
      provider: (
        String(process.env.WHATSAPP_PROVIDER ?? "").trim() ||
        String(process.env.S7_WHATSAPP_PROVIDER ?? "mock").trim()
      ).toLowerCase(),
      mode: String(process.env.S7_WHATSAPP_MODE ?? "mock").trim().toLowerCase(),
      real_provider_configured: isRealWhatsAppProviderConfigured(),
      zapi_token_present:
        String(process.env.S7_ZAPI_TOKEN ?? "").trim() !== "" ||
        String(process.env.ZAPI_TOKEN ?? "").trim() !== "",
      zapi_base_url_present: String(process.env.S7_ZAPI_BASE_URL ?? "").trim() !== "",
      meta_whatsapp_token_present: String(process.env.META_WHATSAPP_TOKEN ?? "").trim() !== "",
    };
  }

  return {
    channel: ch || null,
    note: "channel_hint_unavailable",
  };
}

/**
 * POST /api/notifications/manual/competition-report
 */
export async function handleCompetitionReportManualNotification(req, res) {
  if (req.method !== "POST") {
    return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({
      ok: false,
      success: false,
      error: auth.error.message,
    });
  }

  const body = parseBody(req);
  if (body == null) {
    return jsonError(res, 400, "INVALID_JSON", "Corpo JSON inválido");
  }

  const reportKey = String(body.report_key ?? "").trim();
  const channel = String(body.channel ?? "").trim().toLowerCase();
  logManualCompetitionPayloadDebug(body, channel, "PRE_VALIDATION");

  if (!reportKey) {
    logManualCompetitionPayloadDebug(body, channel, "MISSING_REPORT_KEY");
    return jsonError(res, 400, "MISSING_REPORT_KEY", "report_key é obrigatório");
  }
  if (channel !== "whatsapp" && channel !== "email") {
    logManualCompetitionPayloadDebug(body, channel, "INVALID_CHANNEL");
    return jsonError(res, 400, "INVALID_CHANNEL", 'channel deve ser "whatsapp" ou "email"');
  }

  const sellerId = String(auth.user.id);
  const backendDebug = buildBackendDebug(req);
  const runtimeEnv = getManualSaleRayxRuntimeEnvSnapshot();
  const useSmoke =
    isExplicitSmokeDestinationRequest(body.use_smoke_destination) ||
    isExplicitSmokeDestinationRequest(body.smoke_destination);

  /** @type {Array<{ recipientId?: string | null; recipientPhone?: string; recipientEmail?: string; recipientName?: string | null }>} */
  const recipientTargetsRaw = Array.isArray(body.recipient_targets)
    ? body.recipient_targets.map((t) => ({
        recipientId: t?.recipient_id != null ? String(t.recipient_id) : null,
        recipientPhone: t?.recipient_phone != null ? String(t.recipient_phone) : undefined,
        recipientEmail: t?.recipient_email != null ? String(t.recipient_email) : undefined,
        recipientName: t?.recipient_name != null ? String(t.recipient_name) : null,
      }))
    : [];

  let dedupeMeta = null;
  let recipientTargets = recipientTargetsRaw;

  if (channel === "whatsapp" && recipientTargetsRaw.length > 0) {
    dedupeMeta = dedupeOfficialWhatsAppRecipients(
      recipientTargetsRaw.map((t) => ({
        recipientId: t.recipientId ?? null,
        recipientPhone: t.recipientPhone ?? "",
      })),
      {
        saleId: reportKey,
        channel,
        useSmokeDestination: useSmoke,
      },
    );
    recipientTargets = dedupeMeta.final_recipient_targets;
  }

  if (channel === "email" && recipientTargetsRaw.length > 0) {
    const byEmail = new Map();
    for (const t of recipientTargetsRaw) {
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
    recipientTargets = [...byEmail.values()];
  }

  logNotificationActions("MANUAL_COMPETITION_REPORT_ROUTE_START", {
    seller_id: sellerId,
    report_key: reportKey,
    channel,
    whatsapp_provider: runtimeEnv.whatsapp_provider,
    targets_count: recipientTargets.length,
  });

  try {
    const sharePayload = {
      sellerId,
      reportKey,
      channel,
      templatePayload: body.template_payload ?? null,
      useSmokeDestination: useSmoke,
      shareCaption: body.share_caption != null ? String(body.share_caption) : null,
      shareImageBase64:
        body.share_image_base64 != null ? String(body.share_image_base64) : null,
      shareDocumentBase64:
        body.share_document_base64 != null ? String(body.share_document_base64) : null,
      shareDocumentFilename:
        body.share_document_filename != null ? String(body.share_document_filename) : null,
      shareDocumentMimeType:
        body.share_document_mime_type != null ? String(body.share_document_mime_type) : null,
      shareTextFallback:
        body.share_text_fallback != null ? String(body.share_text_fallback) : null,
      deliveryFormat: body.delivery_format != null ? String(body.delivery_format) : null,
    };

    const result =
      recipientTargets.length > 0
        ? await triggerManualCompetitionReportNotificationsBatch(auth.supabase, {
            ...sharePayload,
            recipientTargets,
          })
        : await triggerManualCompetitionReportNotification(auth.supabase, {
            ...sharePayload,
            recipientId: body.recipient_id != null ? String(body.recipient_id) : null,
            recipientPhone: body.recipient_phone != null ? String(body.recipient_phone) : null,
            recipientEmail: body.recipient_email != null ? String(body.recipient_email) : null,
            recipientName: body.recipient_name != null ? String(body.recipient_name) : null,
          });

    if (dedupeMeta) {
      result.selected_recipient_ids_raw = dedupeMeta.selected_recipient_ids_raw;
      result.selected_recipient_phones_raw = dedupeMeta.selected_recipient_phones_raw;
      result.selected_recipient_phones_normalized = dedupeMeta.selected_recipient_phones_normalized;
      result.duplicate_recipients_removed = dedupeMeta.duplicate_recipients_removed;
      result.final_recipient_targets =
        dedupeMeta.final_recipient_targets?.map((t) => t.recipientPhone) ??
        result.final_recipient_targets;
    }

    result.backend_debug = backendDebug;
    result.seller_id = sellerId;
    result.report_key = reportKey;
    result.channel = channel;

    if (channel === "whatsapp") {
      const audit = auditManualSaleRayxWhatsAppLive({
        sellerId,
        destinationPhone: result.resolved_destination_phone ?? "",
      });
      result.live_audit = audit;
    }

    if (result.ok) {
      return res.status(200).json(result);
    }

    const failure = classifyManualCompetitionFailure(result);
    const deliveryConfigHint = buildManualCompetitionDeliveryConfigHint(channel);
    logManualCompetitionPayloadDebug(
      body,
      channel,
      `DOWNSTREAM_${failure.code || "UNKNOWN"}_${failure.failureType}`,
    );
    if (isDevRuntime()) {
      console.info("[S7_COMPETITION_REPORT_MANUAL_DOWNSTREAM_CONFIG]", {
        failure_type: failure.failureType,
        error: failure.code,
        channel,
        delivery_config_hint: deliveryConfigHint,
      });
    }
    return res.status(failure.status).json({
      ...result,
      ok: false,
      success: false,
      error: failure.code,
      message: failure.message,
      failure_type: failure.failureType,
      delivery_config_hint: deliveryConfigHint,
    });
  } catch (err) {
    console.error("[notifications/manual/competition-report] fatal", {
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      error: "INTERNAL_ERROR",
      message: err?.message ? String(err.message) : "Falha no envio manual do relatório",
      backend_debug: backendDebug,
    });
  }
}
