// =============================================================================
// Provider WhatsApp — facade sobre ProviderResolver (Fase 3.5C)
// =============================================================================

import { config } from "../../../../infra/config.js";
import { resolveWhatsAppProcessorSendPolicy } from "../sales/manualSaleRayxLiveDelivery.js";
import { maskPhoneForLog } from "../../notificationLog.js";
import { logWhatsAppNotification } from "./whatsappLog.js";
import { resolveProviderAdapter } from "../providers/abstraction/ProviderResolver.js";
import { S7_PROVIDER_CHANNEL } from "../providers/abstraction/providerChannels.js";
import {
  hasWhatsAppLiveCredentials,
  isLiveDeliveryActive,
  resolveEffectiveDeliveryPolicy,
} from "../providers/abstraction/providerPolicy.js";
import { parseDeliveryMode } from "../providers/abstraction/deliveryMode.js";
import { providerResponseToWhatsAppLegacy } from "../providers/abstraction/providerResponse.js";
import { logProviderSendOutcome } from "../providers/abstraction/providerObservability.js";

/**
 * @typedef {Object} S7WhatsAppSendInput
 * @property {string} to
 * @property {string} message
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * @typedef {Object} S7WhatsAppSendResult
 * @property {boolean} ok
 * @property {boolean} [simulated]
 * @property {string} [provider]
 * @property {string} [providerMessageId]
 * @property {string} [error]
 * @property {boolean} [blocked]
 * @property {Record<string, unknown>} [raw]
 */

/**
 * Credenciais live configuradas (não implica envio live ativo).
 * @returns {boolean}
 */
export function isRealWhatsAppProviderConfigured() {
  const requested = parseDeliveryMode(config.s7WhatsAppMode);
  return hasWhatsAppLiveCredentials() && requested === "live";
}

/**
 * Live efetivo após política de ambiente (3.5C).
 * @returns {boolean}
 */
export function isWhatsAppLiveDeliveryActive() {
  return isLiveDeliveryActive(S7_PROVIDER_CHANNEL.WHATSAPP);
}

/**
 * @param {string} raw
 */
function normalizePhone(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * @param {S7WhatsAppSendInput} input
 * @returns {Promise<S7WhatsAppSendResult>}
 */
export async function sendS7WhatsApp(input) {
  const started = Date.now();
  const to = normalizePhone(input.to);
  const dispatchId =
    input.metadata?.dispatch_id != null ? String(input.metadata.dispatch_id) : null;
  const attempt = Number(input.metadata?.attempt ?? 1) || 1;

  const channelPolicy = resolveWhatsAppProcessorSendPolicy({
    to,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  });

  if (!channelPolicy.allowed) {
    logWhatsAppNotification("BLOCKED", {
      reason: channelPolicy.reason ?? "NOT_WHITELISTED",
      mode: channelPolicy.mode,
      to_masked: maskPhoneForLog(to),
      outbox_policy_source: channelPolicy.outbox_policy_source,
      processor_whitelist_applied: channelPolicy.processor_whitelist_applied,
      processor_live_bypass_respected: channelPolicy.processor_live_bypass_respected,
      final_send_allowed: false,
    });
    logProviderSendOutcome({
      channel: S7_PROVIDER_CHANNEL.WHATSAPP,
      provider_name: "policy",
      delivery_mode: resolveEffectiveDeliveryPolicy(S7_PROVIDER_CHANNEL.WHATSAPP).deliveryMode,
      dispatch_id: dispatchId,
      attempt,
      duration_ms: Date.now() - started,
      ok: false,
      error_code: channelPolicy.reason ?? "NOT_WHITELISTED",
      simulated: true,
    });
    return {
      ok: false,
      error: channelPolicy.reason ?? "NOT_WHITELISTED",
      blocked: true,
    };
  }

  if (channelPolicy.processor_live_bypass_respected) {
    logWhatsAppNotification("PROCESS_POLICY", {
      dispatch_id: dispatchId,
      outbox_policy_source: channelPolicy.outbox_policy_source,
      processor_whitelist_applied: channelPolicy.processor_whitelist_applied,
      processor_live_bypass_respected: true,
      whitelist_bypass_reason: channelPolicy.whitelist_bypass_reason,
      final_send_allowed: true,
      provider_send_called: true,
      to_masked: maskPhoneForLog(to),
    });
  }

  const { adapter, deliveryMode, tier, policyReason } = resolveProviderAdapter(
    S7_PROVIDER_CHANNEL.WHATSAPP
  );

  const response = await adapter.send({
    to,
    message: String(input.message ?? ""),
    metadata: input.metadata ?? {},
    dispatch_id: dispatchId,
    attempt,
  });

  const legacy = providerResponseToWhatsAppLegacy(response);

  logProviderSendOutcome({
    channel: S7_PROVIDER_CHANNEL.WHATSAPP,
    provider_name: response.provider_name,
    delivery_mode: deliveryMode,
    dispatch_id: dispatchId,
    attempt,
    duration_ms: Date.now() - started,
    ok: legacy.ok,
    error_code: legacy.error ?? null,
    simulated: legacy.simulated,
  });

  if (legacy.ok) {
    logWhatsAppNotification("SENT", {
      simulated: Boolean(legacy.simulated),
      provider: legacy.provider,
      provider_message_id: legacy.providerMessageId,
      message_preview: String(input.message ?? "").slice(0, 120),
      sandbox: deliveryMode === "sandbox",
      delivery_mode: deliveryMode,
      app_tier: tier,
      policy_reason: policyReason ?? null,
    });
  }

  return legacy;
}
