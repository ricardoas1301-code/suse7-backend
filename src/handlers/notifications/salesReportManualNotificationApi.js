// =============================================================================
// POST /api/notifications/manual/sales-report — acionamento manual Relatório de Vendas
// Espelha saleRayxManualNotificationApi.js (WhatsApp via motor central).
// =============================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  triggerManualSalesReportNotification,
  triggerManualSalesReportNotificationsBatch,
} from "../../domain/notifications/central/sales/triggerManualSalesReportNotification.js";
import { dedupeOfficialWhatsAppRecipients } from "../../domain/notifications/central/whatsapp/index.js";
import { logNotificationActions } from "../../domain/notifications/central/actions/notificationActionsLog.js";
import {
  auditManualSaleRayxWhatsAppLive,
  getManualSaleRayxRuntimeEnvSnapshot,
  isExplicitSmokeDestinationRequest,
} from "../../domain/notifications/central/sales/manualSaleRayxLiveDelivery.js";
import os from "node:os";

/**
 * @param {import("http").IncomingMessage} req
 */
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

/**
 * POST /api/notifications/manual/sales-report
 */
export async function handleSalesReportManualNotification(req, res) {
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

  if (!reportKey) {
    return jsonError(res, 400, "MISSING_REPORT_KEY", "report_key é obrigatório");
  }
  if (channel !== "whatsapp" && channel !== "email") {
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

  const dedupeMeta =
    channel === "whatsapp" && recipientTargetsRaw.length > 0
      ? dedupeOfficialWhatsAppRecipients(
          recipientTargetsRaw.map((t) => ({
            recipientId: t.recipientId ?? null,
            recipientPhone: String(t.recipientPhone ?? ""),
          })),
          {
            saleId: reportKey,
            channel,
            useSmokeDestination: useSmoke,
          },
        )
      : null;

  const recipientTargets =
    channel === "whatsapp" ? dedupeMeta?.final_recipient_targets ?? [] : recipientTargetsRaw;

  logNotificationActions("MANUAL_SALES_REPORT_ROUTE_START", {
    seller_id: sellerId,
    report_key: reportKey,
    channel,
    whatsapp_provider: runtimeEnv.whatsapp_provider,
    targets_count: recipientTargets.length,
  });

  try {
    const result =
      recipientTargets.length > 0
        ? await triggerManualSalesReportNotificationsBatch(auth.supabase, {
            sellerId,
            reportKey,
            channel,
            recipientTargets,
            templatePayload: body.template_payload ?? null,
            useSmokeDestination: useSmoke,
            shareCaption: body.share_caption != null ? String(body.share_caption) : null,
            shareImageBase64:
              body.share_image_base64 != null ? String(body.share_image_base64) : null,
            shareImageFilename:
              body.share_image_filename != null ? String(body.share_image_filename) : null,
            shareDocumentBase64:
              body.share_document_base64 != null ? String(body.share_document_base64) : null,
            shareDocumentFilename:
              body.share_document_filename != null ? String(body.share_document_filename) : null,
            shareDocumentMimeType:
              body.share_document_mime_type != null ? String(body.share_document_mime_type) : null,
            deliveryFormat: body.delivery_format != null ? String(body.delivery_format) : null,
          })
        : await triggerManualSalesReportNotification(auth.supabase, {
            sellerId,
            reportKey,
            channel,
            recipientId: body.recipient_id != null ? String(body.recipient_id) : null,
            recipientPhone: body.recipient_phone != null ? String(body.recipient_phone) : null,
            recipientEmail: body.recipient_email != null ? String(body.recipient_email) : null,
            recipientName: body.recipient_name != null ? String(body.recipient_name) : null,
            templatePayload: body.template_payload ?? null,
            useSmokeDestination: useSmoke,
            shareCaption: body.share_caption != null ? String(body.share_caption) : null,
            shareImageBase64:
              body.share_image_base64 != null ? String(body.share_image_base64) : null,
            shareImageFilename:
              body.share_image_filename != null ? String(body.share_image_filename) : null,
            shareDocumentBase64:
              body.share_document_base64 != null ? String(body.share_document_base64) : null,
            shareDocumentFilename:
              body.share_document_filename != null ? String(body.share_document_filename) : null,
            shareDocumentMimeType:
              body.share_document_mime_type != null ? String(body.share_document_mime_type) : null,
            deliveryFormat: body.delivery_format != null ? String(body.delivery_format) : null,
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

    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error("[notifications/manual/sales-report] fatal", {
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
