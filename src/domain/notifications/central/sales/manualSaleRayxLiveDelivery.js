// =============================================================================
// Política de envio live controlado — Modal Raio-X manual (Fase 3.5C.1.A4)
// =============================================================================

import { config } from "../../../../infra/config.js";
import { S7_MAIL_LOGO_DATA_URI } from "../email/s7MailLogoDataUri.js";
import { isWhatsAppLiveDeliveryActive } from "../whatsapp/sendWhatsAppMessage.js";
import {
  resolveWhatsAppProviderName,
  WHATSAPP_PROVIDER_NAMES,
} from "../providers/whatsapp/whatsappProviderEnv.js";
import {
  evaluateWhatsAppSendPolicy,
  getWhatsAppSandboxWhitelist,
  isDevSandboxWhatsAppMode,
} from "../whatsapp/whatsappSandboxPolicy.js";
import {
  evaluateProviderSmokePolicy,
  isProviderSmokeEnabled,
} from "../providers/abstraction/providerSmokePolicy.js";
import { isLiveDeliveryExplicitlyAllowed } from "../providers/abstraction/providerPolicy.js";
import { parseDeliveryMode } from "../providers/abstraction/deliveryMode.js";

/** @typedef {"recipient_body" | "smoke_explicit" | "recipient_id" | "central_recipient" | "seller_profile" | "unresolved"} ManualRayxLiveDestinationSource */

export const MANUAL_RAYX_LIVE_DESTINATION_SOURCE = Object.freeze({
  RECIPIENT_BODY: "recipient_body",
  SMOKE_EXPLICIT: "smoke_explicit",
  RECIPIENT_ID: "recipient_id",
  CENTRAL_RECIPIENT: "central_recipient",
  SELLER_PROFILE: "seller_profile",
  UNRESOLVED: "unresolved",
});

import { normalizeBrazilWhatsAppPhone } from "./manualSaleRayxRecipientTargets.js";

/**
 * @param {string} raw
 */
export function normalizeManualRayxPhone(raw) {
  return normalizeBrazilWhatsAppPhone(raw) || String(raw ?? "").replace(/\D/g, "");
}

function readEnvFlag(key, configFallback = "") {
  const live = process.env[key];
  if (live != null && String(live).trim() !== "") return String(live).trim();
  return String(configFallback ?? "").trim();
}

/**
 * Telefone da instância Z-API (opcional) — bloqueia envio live se destino coincidir.
 * @returns {string}
 */
export function getZapiInstancePhoneDigits() {
  const raw =
    readEnvFlag("S7_ZAPI_INSTANCE_PHONE", "") || readEnvFlag("WHATSAPP_INSTANCE_PHONE", "");
  return normalizeManualRayxPhone(raw);
}

/**
 * @param {boolean | string | number | null | undefined} raw
 */
export function isExplicitSmokeDestinationRequest(raw) {
  if (raw === true || raw === 1) return true;
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/**
 * Snapshot do que o processo Node está lendo agora (process.env + config fallback).
 */
export function getManualSaleRayxRuntimeEnvSnapshot() {
  return {
    whatsapp_provider: resolveWhatsAppProviderName(),
    whatsapp_provider_env: readEnvFlag("WHATSAPP_PROVIDER", config.s7WhatsAppProvider),
    s7_whatsapp_provider_env: readEnvFlag("S7_WHATSAPP_PROVIDER", config.s7WhatsAppProvider),
    s7_whatsapp_mode: readEnvFlag("S7_WHATSAPP_MODE", config.s7WhatsAppMode),
    s7_allow_live_delivery: readEnvFlag("S7_ALLOW_LIVE_DELIVERY", config.s7AllowLiveDelivery),
    s7_provider_smoke_enabled: readEnvFlag("S7_PROVIDER_SMOKE_ENABLED", config.s7ProviderSmokeEnabled),
    s7_provider_smoke_phone: normalizeManualRayxPhone(
      readEnvFlag("S7_PROVIDER_SMOKE_PHONE", config.s7ProviderSmokePhone)
    ),
    s7_provider_smoke_seller: readEnvFlag("S7_PROVIDER_SMOKE_SELLER", config.s7ProviderSmokeSeller),
    s7_whatsapp_sandbox_whitelist: readEnvFlag(
      "S7_WHATSAPP_SANDBOX_WHITELIST",
      config.s7WhatsAppSandboxWhitelist
    ),
    s7_zapi_instance_phone_configured: Boolean(getZapiInstancePhoneDigits()),
    s7_zapi_base_url_configured: Boolean(readEnvFlag("S7_ZAPI_BASE_URL", config.s7ZapiBaseUrl)),
    live_delivery_active: isWhatsAppLiveDeliveryActive(),
    live_delivery_explicit: isLiveDeliveryExplicitlyAllowed(),
    parsed_whatsapp_mode: parseDeliveryMode(readEnvFlag("S7_WHATSAPP_MODE", config.s7WhatsAppMode)),
  };
}

/**
 * Pré-check documentado para smoke / DevCenter.
 */
export function getManualSaleRayxLivePrecheck() {
  return getManualSaleRayxRuntimeEnvSnapshot();
}

/**
 * Telefone de smoke — somente quando smoke explícito está habilitado e seller confere.
 * @param {string} sellerId
 */
export function resolveExplicitSmokePhoneForSeller(sellerId) {
  if (!isProviderSmokeEnabled()) return null;
  const smokeSeller = readEnvFlag("S7_PROVIDER_SMOKE_SELLER", config.s7ProviderSmokeSeller);
  const smokePhone = normalizeManualRayxPhone(
    readEnvFlag("S7_PROVIDER_SMOKE_PHONE", config.s7ProviderSmokePhone)
  );
  if (!smokeSeller || !smokePhone || String(sellerId).trim() !== smokeSeller) return null;
  return smokePhone;
}

/**
 * @deprecated Use resolveExplicitSmokePhoneForSeller apenas com use_smoke_destination no body.
 * Mantido para scripts legados — não aplica override automático.
 */
export function resolveControlledSmokePhoneForSeller(_sellerId) {
  return null;
}

/**
 * @param {string} digits
 */
export function isValidManualRayxPhoneDigits(digits) {
  const d = normalizeManualRayxPhone(digits);
  return d.length >= 10 && d.length <= 15;
}

/**
 * @param {{
 *   normalizedDestinationPhone: string;
 *   liveDestinationSource?: ManualRayxLiveDestinationSource | string | null;
 *   smokeOverrideApplied?: boolean;
 * }} input
 */
export function evaluateManualRayxLiveDestinationGuard(input) {
  const phone = normalizeManualRayxPhone(input.normalizedDestinationPhone);
  const source = String(input.liveDestinationSource ?? MANUAL_RAYX_LIVE_DESTINATION_SOURCE.UNRESOLVED);
  const smokeOverrideApplied = input.smokeOverrideApplied === true;

  if (!phone) {
    return { ok: false, reason: "RECIPIENT_PHONE_REQUIRED" };
  }
  if (!isValidManualRayxPhoneDigits(phone)) {
    return { ok: false, reason: "RECIPIENT_PHONE_INVALID" };
  }

  const instancePhone = getZapiInstancePhoneDigits();
  if (instancePhone && phone === instancePhone) {
    return { ok: false, reason: "INSTANCE_PHONE_BLOCKED" };
  }

  if (smokeOverrideApplied && source !== MANUAL_RAYX_LIVE_DESTINATION_SOURCE.SMOKE_EXPLICIT) {
    return { ok: false, reason: "SMOKE_OVERRIDE_NOT_EXPLICIT" };
  }

  if (source === MANUAL_RAYX_LIVE_DESTINATION_SOURCE.SELLER_PROFILE) {
    return { ok: false, reason: "PROFILE_FALLBACK_BLOCKED_FOR_LIVE" };
  }

  if (source === MANUAL_RAYX_LIVE_DESTINATION_SOURCE.UNRESOLVED) {
    return { ok: false, reason: "RECIPIENT_PHONE_REQUIRED" };
  }

  return { ok: true, reason: null };
}

/**
 * Monta trace de destino para logs e resposta HTTP.
 * @param {{
 *   originalRecipientPhone?: string | null;
 *   normalizedDestinationPhone?: string | null;
 *   smokeEnabled?: boolean;
 *   smokeOverrideApplied?: boolean;
 *   liveDestinationSource?: string | null;
 * }} input
 */
export function buildManualRayxDestinationTrace(input) {
  return {
    original_recipient_phone: input.originalRecipientPhone ?? null,
    normalized_destination_phone: normalizeManualRayxPhone(input.normalizedDestinationPhone ?? ""),
    smoke_enabled: input.smokeEnabled === true,
    smoke_override_applied: input.smokeOverrideApplied === true,
    live_destination_source: input.liveDestinationSource ?? MANUAL_RAYX_LIVE_DESTINATION_SOURCE.UNRESOLVED,
    live_policy_applied: input.livePolicyApplied === true,
    sandbox_whitelist_applied: input.sandboxWhitelistApplied === true,
    whitelist_bypass_reason: input.whitelistBypassReason ?? null,
  };
}

/**
 * Live explícito Raio-X: destinatário real, sem smoke override.
 * @param {{
 *   smokeOverrideApplied?: boolean;
 *   liveDestinationSource?: string | null;
 * }} input
 */
export function isManualRayxLiveExplicitAllowed(input) {
  const smokeOverrideApplied = input.smokeOverrideApplied === true;
  const source = String(input.liveDestinationSource ?? "");
  if (smokeOverrideApplied || source === MANUAL_RAYX_LIVE_DESTINATION_SOURCE.SMOKE_EXPLICIT) {
    return false;
  }
  return (
    isWhatsAppLiveDeliveryActive() &&
    isLiveDeliveryExplicitlyAllowed() &&
    resolveWhatsAppProviderName() === WHATSAPP_PROVIDER_NAMES.ZAPI
  );
}

/**
 * Política de envio manual Raio-X — separa live explícito de sandbox/smoke.
 * @param {{
 *   destinationPhone: string;
 *   smokeOverrideApplied?: boolean;
 *   liveDestinationSource?: string | null;
 * }} input
 */
export const MANUAL_RAYX_FLOW = "manual_sale_rayx";
export const MANUAL_RAYX_SOURCE_MODULE = "sale_rayx_modal";

/**
 * Metadata persistida na outbox — processor usa para respeitar bypass live.
 * @param {{
 *   originalRecipientPhone?: string | null;
 *   normalizedDestinationPhone?: string | null;
 *   smokeEnabled?: boolean;
 *   smokeOverrideApplied?: boolean;
 *   liveDestinationSource?: string | null;
 *   livePolicyApplied?: boolean;
 *   sandboxWhitelistApplied?: boolean;
 *   whitelistBypassReason?: string | null;
 * }} input
 */
export function buildManualRayxOutboxPolicyMetadata(input) {
  const trace = buildManualRayxDestinationTrace(input);
  return {
    flow: MANUAL_RAYX_FLOW,
    type_key: "MANUAL_SALE_RAYX",
    source_module: MANUAL_RAYX_SOURCE_MODULE,
    ...trace,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
/**
 * Gate de smoke no provider Z-API — não bloqueia live explícito Raio-X.
 * @param {{ sellerId?: string | null; phone?: string | null; metadata?: Record<string, unknown> | null }} input
 */
export function resolveZapiProviderSmokeGate(input) {
  const meta = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const phone = normalizeManualRayxPhone(input.phone);

  if (hasManualRayxLiveExplicitBypass(meta)) {
    return {
      allowed: true,
      reason: null,
      provider_smoke_policy_applied: false,
      provider_live_bypass_respected: true,
      provider_final_send_allowed: true,
      zapi_request_called: false,
    };
  }

  if (meta.smoke_override_applied === true && isProviderSmokeEnabled()) {
    const smoke = evaluateProviderSmokePolicy({
      sellerId: input.sellerId,
      phone,
    });
    return {
      allowed: smoke.allowed,
      reason: smoke.reason ?? null,
      provider_smoke_policy_applied: true,
      provider_live_bypass_respected: false,
      provider_final_send_allowed: smoke.allowed,
      zapi_request_called: false,
    };
  }

  if (isProviderSmokeEnabled()) {
    return {
      allowed: true,
      reason: null,
      provider_smoke_policy_applied: false,
      provider_live_bypass_respected: false,
      provider_final_send_allowed: true,
      zapi_request_called: false,
    };
  }

  return {
    allowed: true,
    reason: null,
    provider_smoke_policy_applied: false,
    provider_live_bypass_respected: false,
    provider_final_send_allowed: true,
    zapi_request_called: false,
  };
}

export function hasManualRayxLiveExplicitBypass(metadata) {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata;
  const isManualFlow =
    m.flow === MANUAL_RAYX_FLOW ||
    m.type_key === "MANUAL_SALE_RAYX" ||
    m.source_module === MANUAL_RAYX_SOURCE_MODULE;
  if (!isManualFlow) return false;
  return (
    m.live_policy_applied === true &&
    m.sandbox_whitelist_applied === false &&
    m.whitelist_bypass_reason === "LIVE_EXPLICIT_ALLOWED" &&
    m.smoke_override_applied !== true
  );
}

/**
 * Política no processor/outbox — respeita metadata do Raio-X manual antes da whitelist global.
 * @param {{ to: string; metadata?: Record<string, unknown> | null }} input
 */
export function resolveWhatsAppProcessorSendPolicy(input) {
  const phone = normalizeManualRayxPhone(input.to);
  const meta = input.metadata && typeof input.metadata === "object" ? input.metadata : {};

  if (hasManualRayxLiveExplicitBypass(meta)) {
    return {
      allowed: true,
      reason: null,
      mode: "live",
      outbox_policy_source: "manual_sale_rayx_live_explicit",
      processor_whitelist_applied: false,
      processor_live_bypass_respected: true,
      whitelist_bypass_reason: "LIVE_EXPLICIT_ALLOWED",
      final_send_allowed: true,
    };
  }

  const sendPolicy = evaluateWhatsAppSendPolicy(phone);
  const blockedByWhitelist = !sendPolicy.allowed && sendPolicy.reason === "NOT_WHITELISTED";

  return {
    allowed: sendPolicy.allowed,
    reason: sendPolicy.reason,
    mode: sendPolicy.mode,
    outbox_policy_source: "global_sandbox_policy",
    processor_whitelist_applied: blockedByWhitelist,
    processor_live_bypass_respected: false,
    whitelist_bypass_reason: null,
    final_send_allowed: sendPolicy.allowed,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {{
 *   caption: string;
 *   imageBase64: string;
 *   mimeType?: string;
 *   deliveryFormat?: string;
 *   shareCacheKey?: string | null;
 *   documentBase64?: string | null;
 *   documentFilename?: string | null;
 *   documentMimeType?: string | null;
 * }} share
 */
export async function patchManualRayxWhatsAppOutboxShare(supabase, dispatchId, share) {
  const id = String(dispatchId ?? "").trim();
  if (!id) return { ok: false, error: "MISSING_DISPATCH_ID" };

  const imageBase64 = String(share.imageBase64 ?? "").trim();
  const caption = String(share.caption ?? "").trim();
  if (!imageBase64) return { ok: false, error: "MISSING_IMAGE" };

  const mimeType = share.mimeType != null ? String(share.mimeType) : "image/png";
  const dataUri = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:${mimeType};base64,${imageBase64}`;

  const documentBase64 = String(share.documentBase64 ?? "").trim();
  const documentFilename =
    String(share.documentFilename ?? "").trim() || "relatorio.xlsx";
  const documentMimeType =
    share.documentMimeType != null
      ? String(share.documentMimeType)
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const documentDataUri = documentBase64
    ? documentBase64.startsWith("data:")
      ? documentBase64
      : `data:${documentMimeType};base64,${documentBase64}`
    : "";

  const { data: row, error } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .select("id, metadata")
    .eq("dispatch_id", id)
    .maybeSingle();

  if (error) throw error;
  if (!row?.id) return { ok: false, error: "OUTBOX_NOT_FOUND" };

  const prev =
    row.metadata && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : {};

  const { error: updErr } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .update({
      message_text: caption || prev.message_text || "",
      metadata: {
        ...prev,
        delivery_format: share.deliveryFormat ?? "image",
        share_image_data_uri: dataUri,
        share_image_mime: mimeType,
        share_cache_key: share.shareCacheKey ?? null,
        share_caption: caption || null,
        ...(documentDataUri
          ? {
              share_document_data_uri: documentDataUri,
              share_document_filename: documentFilename,
              share_document_mime: documentMimeType,
            }
          : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updErr) throw updErr;
  return { ok: true, outbox_id: String(row.id) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {{
 *   subject: string;
 *   html: string;
 *   text: string;
 *   imageDataUri?: string | null;
 *   imageFilename?: string | null;
 *   shareCacheKey?: string | null;
 *   documentBase64?: string | null;
 *   documentFilename?: string | null;
 *   documentMimeType?: string | null;
 * }} rendered
 */
export async function patchManualRayxEmailOutboxShare(supabase, dispatchId, rendered) {
  const id = String(dispatchId ?? "").trim();
  if (!id) return { ok: false, error: "MISSING_DISPATCH_ID" };

  const { data: row, error } = await supabase
    .from("s7_notification_email_outbox")
    .select("id, metadata")
    .eq("dispatch_id", id)
    .maybeSingle();

  if (error) throw error;
  if (!row?.id) return { ok: false, error: "OUTBOX_NOT_FOUND" };

  const prev =
    row.metadata && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : {};
  const documentBase64 = String(rendered.documentBase64 ?? "").trim();
  const documentFilename = String(rendered.documentFilename ?? "").trim() || "raio-x-venda.xlsx";
  const documentMimeType =
    rendered.documentMimeType != null
      ? String(rendered.documentMimeType)
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const documentDataUri = documentBase64
    ? documentBase64.startsWith("data:")
      ? documentBase64
      : `data:${documentMimeType};base64,${documentBase64}`
    : "";

  const { error: updErr } = await supabase
    .from("s7_notification_email_outbox")
    .update({
      subject: String(rendered.subject ?? "").trim(),
      body_html: String(rendered.html ?? ""),
      body_text: String(rendered.text ?? ""),
      metadata: {
        ...prev,
        sale_rayx_premium_email: true,
        delivery_format: "image",
        share_email_file_attachments: true,
        s7_mail_logo_data_uri: S7_MAIL_LOGO_DATA_URI,
        s7_mail_logo_filename: "suse7-logo-abreviada.png",
        share_image_data_uri: rendered.imageDataUri ?? null,
        share_image_filename: String(rendered.imageFilename ?? "").trim() || "raio-x-venda.png",
        share_cache_key: rendered.shareCacheKey ?? null,
        ...(documentDataUri
          ? {
              share_document_data_uri: documentDataUri,
              share_document_filename: documentFilename,
              share_document_mime: documentMimeType,
            }
          : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updErr) throw updErr;
  return { ok: true, outbox_id: String(row.id) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {Record<string, unknown>} policyMetadata
 */
export async function patchManualRayxWhatsAppOutboxPolicy(supabase, dispatchId, policyMetadata) {
  const id = String(dispatchId ?? "").trim();
  if (!id) return { ok: false, error: "MISSING_DISPATCH_ID" };

  const { data: row, error } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .select("id, metadata")
    .eq("dispatch_id", id)
    .maybeSingle();

  if (error) throw error;
  if (!row?.id) return { ok: false, error: "OUTBOX_NOT_FOUND" };

  const prev =
    row.metadata && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : {};

  const { error: updErr } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .update({
      metadata: { ...prev, ...policyMetadata },
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updErr) throw updErr;
  return { ok: true, outbox_id: String(row.id) };
}

export function evaluateManualRayxLiveSendPolicy(input) {
  const phone = normalizeManualRayxPhone(input.destinationPhone);
  const smokeOverrideApplied = input.smokeOverrideApplied === true;
  const whitelist = getWhatsAppSandboxWhitelist();

  if (isManualRayxLiveExplicitAllowed(input)) {
    return {
      allowed: true,
      reason: null,
      mode: "live",
      live_policy_applied: true,
      sandbox_whitelist_applied: false,
      whitelist_bypass_reason: "LIVE_EXPLICIT_ALLOWED",
    };
  }

  const sendPolicy = evaluateWhatsAppSendPolicy(phone);
  const mode = readEnvFlag("S7_WHATSAPP_MODE", config.s7WhatsAppMode).toLowerCase();
  const mockOrSandbox =
    mode === "mock" || isDevSandboxWhatsAppMode() || mode === "sandbox" || mode === "dev_sandbox";
  const sandboxWhitelistApplied =
    whitelist.length > 0 &&
    !whitelist.includes(phone) &&
    !sendPolicy.allowed &&
    (mockOrSandbox || smokeOverrideApplied);

  return {
    allowed: sendPolicy.allowed,
    reason: sendPolicy.reason,
    mode: sendPolicy.mode,
    live_policy_applied: false,
    sandbox_whitelist_applied: sandboxWhitelistApplied,
    whitelist_bypass_reason: sendPolicy.allowed ? null : (sendPolicy.reason ?? "SANDBOX_WHITELIST"),
  };
}

/**
 * Auditoria completa — por que live entrou ou não.
 * @param {{
 *   sellerId: string;
 *   destinationPhone: string;
 *   liveDestinationSource?: string | null;
 *   smokeOverrideApplied?: boolean;
 *   destinationTrace?: Record<string, unknown>;
 * }} input
 */
export function auditManualSaleRayxWhatsAppLive(input) {
  const sellerId = String(input.sellerId ?? "").trim();
  const phone = normalizeManualRayxPhone(input.destinationPhone);
  const env = getManualSaleRayxRuntimeEnvSnapshot();
  const sendPolicy = evaluateManualRayxLiveSendPolicy(input);
  const smokeEnabled = isProviderSmokeEnabled();
  const smokePolicy =
    smokeEnabled && input.smokeOverrideApplied === true
      ? evaluateProviderSmokePolicy({ sellerId, phone })
      : { allowed: false, reason: "SMOKE_NOT_REQUESTED" };
  const decision = canProcessManualSaleRayxWhatsAppLive(input);

  return {
    env,
    seller_id: sellerId,
    destination_phone: phone,
    send_policy: sendPolicy,
    smoke_enabled: smokeEnabled,
    smoke_policy: smokePolicy,
    live_policy_applied: sendPolicy.live_policy_applied === true,
    sandbox_whitelist_applied: sendPolicy.sandbox_whitelist_applied === true,
    whitelist_bypass_reason: sendPolicy.whitelist_bypass_reason ?? null,
    will_process_outbox: decision.process,
    live_process_reason: decision.process ? "LIVE_DISPATCH_ELIGIBLE" : decision.reason,
    ...(input.destinationTrace ? { destination: input.destinationTrace } : {}),
  };
}

/**
 * Decide se a rota manual pode processar a outbox WhatsApp imediatamente (Z-API real).
 *
 * @param {{
 *   sellerId: string;
 *   destinationPhone: string;
 *   liveDestinationSource?: string | null;
 *   smokeOverrideApplied?: boolean;
 * }} input
 */
export function canProcessManualSaleRayxWhatsAppLive(input) {
  const sellerId = String(input.sellerId ?? "").trim();
  const phone = normalizeManualRayxPhone(input.destinationPhone);

  if (!isWhatsAppLiveDeliveryActive()) {
    return { process: false, reason: "LIVE_DELIVERY_OFF" };
  }
  if (resolveWhatsAppProviderName() !== WHATSAPP_PROVIDER_NAMES.ZAPI) {
    return { process: false, reason: "PROVIDER_NOT_ZAPI" };
  }

  const guard = evaluateManualRayxLiveDestinationGuard({
    normalizedDestinationPhone: phone,
    liveDestinationSource: input.liveDestinationSource,
    smokeOverrideApplied: input.smokeOverrideApplied,
  });
  if (!guard.ok) {
    return { process: false, reason: guard.reason ?? "DESTINATION_BLOCKED" };
  }

  const sendPolicy = evaluateManualRayxLiveSendPolicy(input);
  if (!sendPolicy.allowed) {
    return {
      process: false,
      reason: sendPolicy.reason ?? "NOT_WHITELISTED",
      live_policy_applied: sendPolicy.live_policy_applied === true,
      sandbox_whitelist_applied: sendPolicy.sandbox_whitelist_applied === true,
      whitelist_bypass_reason: sendPolicy.whitelist_bypass_reason ?? null,
    };
  }

  if (input.smokeOverrideApplied === true && isProviderSmokeEnabled()) {
    const smoke = evaluateProviderSmokePolicy({ sellerId, phone });
    if (!smoke.allowed) {
      return {
        process: false,
        reason: smoke.reason ?? "BLOCKED_BY_SMOKE_POLICY",
        live_policy_applied: false,
        sandbox_whitelist_applied: sendPolicy.sandbox_whitelist_applied === true,
        whitelist_bypass_reason: sendPolicy.whitelist_bypass_reason ?? null,
      };
    }
  }

  return {
    process: true,
    reason: null,
    live_policy_applied: sendPolicy.live_policy_applied === true,
    sandbox_whitelist_applied: sendPolicy.sandbox_whitelist_applied === true,
    whitelist_bypass_reason: sendPolicy.whitelist_bypass_reason ?? null,
  };
}
