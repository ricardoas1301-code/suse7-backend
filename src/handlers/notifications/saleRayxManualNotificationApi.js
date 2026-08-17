// =============================================================================
// POST /api/notifications/manual/sale-rayx — acionamento manual Raio-X (3.5C.1.A3)
// =============================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  triggerManualSaleRayxNotification,
  triggerManualSaleRayxNotificationsBatch,
} from "../../domain/notifications/central/sales/triggerManualSaleRayxNotification.js";
import { dedupeOfficialWhatsAppRecipients } from "../../domain/notifications/central/whatsapp/index.js";
import {
  auditManualSaleRayxWhatsAppLive,
  getManualSaleRayxRuntimeEnvSnapshot,
  isExplicitSmokeDestinationRequest,
} from "../../domain/notifications/central/sales/manualSaleRayxLiveDelivery.js";
import { logNotificationActions } from "../../domain/notifications/central/actions/notificationActionsLog.js";
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
    s7_provider_smoke_enabled: env.s7_provider_smoke_enabled,
    s7_provider_smoke_phone: env.s7_provider_smoke_phone,
    s7_provider_smoke_seller: env.s7_provider_smoke_seller,
    live_delivery_active: env.live_delivery_active,
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {ReturnType<typeof buildBackendDebug>} backendDebug
 */
function withBackendDebug(payload, backendDebug) {
  return { ...payload, backend_debug: backendDebug };
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
 * POST /api/notifications/manual/sale-rayx
 */
export async function handleSaleRayxManualNotification(req, res) {
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

  const saleId = String(body.sale_id ?? "").trim();
  const channel = String(body.channel ?? "").trim().toLowerCase();

  if (!saleId) {
    return jsonError(res, 400, "MISSING_SALE_ID", "sale_id é obrigatório");
  }
  if (channel !== "whatsapp" && channel !== "email") {
    return jsonError(res, 400, "INVALID_CHANNEL", 'channel deve ser "whatsapp" ou "email"');
  }

  const routeStarted = Date.now();
  const sellerId = String(auth.user.id);
  const backendDebug = buildBackendDebug(req);
  const runtimeEnv = getManualSaleRayxRuntimeEnvSnapshot();
  const recipientPhoneHint =
    body.recipient_phone != null ? String(body.recipient_phone).replace(/\D/g, "") : null;

  logNotificationActions("MANUAL_SALE_RAYX_ROUTE_START", {
    seller_id: sellerId,
    sale_id: saleId,
    channel,
    recipient_phone_body: recipientPhoneHint,
    whatsapp_provider: runtimeEnv.whatsapp_provider,
    s7_whatsapp_mode: runtimeEnv.s7_whatsapp_mode,
    s7_allow_live_delivery: runtimeEnv.s7_allow_live_delivery,
    s7_provider_smoke_enabled: runtimeEnv.s7_provider_smoke_enabled,
    s7_provider_smoke_seller: runtimeEnv.s7_provider_smoke_seller,
    s7_provider_smoke_phone: runtimeEnv.s7_provider_smoke_phone,
    live_delivery_active: runtimeEnv.live_delivery_active,
  });

  try {
    const useSmoke =
      isExplicitSmokeDestinationRequest(body.use_smoke_destination) ||
      isExplicitSmokeDestinationRequest(body.smoke_destination);

    /** @type {Array<{ recipientId?: string | null; recipientPhone: string }>} */
    const recipientTargetsRaw = Array.isArray(body.recipient_targets)
      ? body.recipient_targets.map((t) => ({
          recipientId: t?.recipient_id != null ? String(t.recipient_id) : null,
          recipientPhone: String(t?.recipient_phone ?? ""),
        }))
      : [];

    const dedupeMeta =
      channel === "whatsapp" && recipientTargetsRaw.length > 0
        ? dedupeOfficialWhatsAppRecipients(recipientTargetsRaw, {
            saleId,
            channel,
            useSmokeDestination: useSmoke,
          })
        : null;

    const recipientTargets = dedupeMeta?.final_recipient_targets ?? [];

    if (dedupeMeta) {
      logNotificationActions("MANUAL_SALE_RAYX_ROUTE_DEDUPE", {
        seller_id: sellerId,
        sale_id: saleId,
        selected_recipient_ids_raw: dedupeMeta.selected_recipient_ids_raw,
        selected_recipient_phones_raw: dedupeMeta.selected_recipient_phones_raw,
        selected_recipient_phones_normalized: dedupeMeta.selected_recipient_phones_normalized,
        duplicate_recipients_removed: dedupeMeta.duplicate_recipients_removed,
        final_recipient_targets: dedupeMeta.final_recipient_targets,
        dispatches_planned: dedupeMeta.dispatches_planned,
      });
    }

    const result =
      recipientTargets.length > 0
        ? await triggerManualSaleRayxNotificationsBatch(auth.supabase, {
            sellerId,
            saleId,
            channel,
            recipientTargets,
            useSmokeDestination: useSmoke,
            shareImageBase64:
              body.share_image_base64 != null ? String(body.share_image_base64) : null,
            shareCaption: body.share_caption != null ? String(body.share_caption) : null,
            deliveryFormat: body.delivery_format != null ? String(body.delivery_format) : null,
            shareCacheKey: body.share_cache_key != null ? String(body.share_cache_key) : null,
            shareTextFallback:
              body.share_text_fallback != null ? String(body.share_text_fallback) : null,
            recipientName: body.recipient_name != null ? String(body.recipient_name) : null,
            shareDocumentBase64:
              body.share_document_base64 != null ? String(body.share_document_base64) : null,
            shareDocumentFilename:
              body.share_document_filename != null ? String(body.share_document_filename) : null,
            shareDocumentMimeType:
              body.share_document_mime_type != null ? String(body.share_document_mime_type) : null,
          })
        : await triggerManualSaleRayxNotification(auth.supabase, {
            sellerId,
            saleId,
            channel,
            recipientId: body.recipient_id != null ? String(body.recipient_id) : null,
            recipientPhone: body.recipient_phone != null ? String(body.recipient_phone) : null,
            recipientEmail: body.recipient_email != null ? String(body.recipient_email) : null,
            useSmokeDestination: useSmoke,
            shareImageBase64:
              body.share_image_base64 != null ? String(body.share_image_base64) : null,
            shareCaption: body.share_caption != null ? String(body.share_caption) : null,
            deliveryFormat: body.delivery_format != null ? String(body.delivery_format) : null,
            shareCacheKey: body.share_cache_key != null ? String(body.share_cache_key) : null,
            shareTextFallback:
              body.share_text_fallback != null ? String(body.share_text_fallback) : null,
            recipientName: body.recipient_name != null ? String(body.recipient_name) : null,
            shareDocumentBase64:
              body.share_document_base64 != null ? String(body.share_document_base64) : null,
            shareDocumentFilename:
              body.share_document_filename != null ? String(body.share_document_filename) : null,
            shareDocumentMimeType:
              body.share_document_mime_type != null ? String(body.share_document_mime_type) : null,
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
    result.sale_id = saleId;
    result.channel = channel;

    if (channel === "whatsapp") {
      const audit = auditManualSaleRayxWhatsAppLive({
        sellerId,
        destinationPhone: result.resolved_destination_phone ?? recipientPhoneHint ?? "",
      });
      result.live_audit = audit;
      logNotificationActions("MANUAL_SALE_RAYX_ROUTE_LIVE_AUDIT", {
        seller_id: sellerId,
        sale_id: saleId,
        original_recipient_phone: result.original_recipient_phone,
        normalized_destination_phone: result.normalized_destination_phone,
        smoke_enabled: result.smoke_enabled,
        smoke_override_applied: result.smoke_override_applied,
        live_destination_source: result.live_destination_source,
        live_policy_applied: result.live_policy_applied,
        sandbox_whitelist_applied: result.sandbox_whitelist_applied,
        whitelist_bypass_reason: result.whitelist_bypass_reason,
        ...audit,
        process_outbox_called: result.process_outbox_called === true,
        live_process_reason: result.live_process_reason,
        real_send_executed: result.real_send_executed,
      });
    }

    if (!result.ok) {
      const status =
        result.error === "SALE_NOT_FOUND"
          ? 404
          : result.error === "INVALID_PHONE" || result.error === "INVALID_EMAIL"
            ? 400
            : 422;
      return res.status(status).json(withBackendDebug(result, backendDebug));
    }

    const durationMs = Date.now() - routeStarted;
    return res.status(200).json(
      withBackendDebug(
        {
          ...result,
          duration_ms: result.duration_ms ?? durationMs,
          route_duration_ms: durationMs,
        },
        backendDebug
      )
    );
  } catch (e) {
    return jsonError(res, 500, "INTERNAL", e?.message ?? "Erro ao acionar notificação");
  }
}
