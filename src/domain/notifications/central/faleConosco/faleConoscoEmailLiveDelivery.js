// =============================================================================
// S7 — Fale Conosco — política de envio live (homologada com Edge + Resend direto)
// Formulário público: não usa whitelist de notificações do seller.
// =============================================================================

import { config } from "../../../../infra/config.js";
import {
  canSendRealEmailNow,
  isRealEmailProviderConfigured,
} from "../email/S7EmailProvider.js";
import { isDevSandboxEmailMode } from "../email/emailSandboxPolicy.js";

/**
 * Snapshot de ambiente (sem secrets) para logs S5.13.
 */
export function getFaleConoscoEmailRuntimeSnapshot() {
  const provider = String(config.s7EmailProvider ?? "mock").toLowerCase();
  const mode = String(config.s7EmailMode ?? "mock").toLowerCase();
  return {
    s7_email_provider: provider,
    s7_email_mode: mode,
    s7_email_from: String(config.s7EmailFrom ?? "").trim() || null,
    resend_configured: provider === "resend" && Boolean(config.resendApiKey),
    can_send_real: canSendRealEmailNow(),
    is_real_provider_configured: isRealEmailProviderConfigured(),
    dev_sandbox: isDevSandboxEmailMode(),
    fale_conosco_live_capable:
      (provider === "resend" && Boolean(config.resendApiKey)) ||
      (provider === "sendgrid" && Boolean(config.sendgridApiKey)),
  };
}

/**
 * Indica se o backend pode tentar envio real no fluxo Fale Conosco.
 */
export function canSendFaleConoscoEmailLive() {
  const provider = String(config.s7EmailProvider ?? "").toLowerCase();
  if (provider === "resend" && config.resendApiKey) return true;
  if (provider === "sendgrid" && config.sendgridApiKey) return true;
  return false;
}

/**
 * Confirma entrega real (não mock / não simulado / não pending).
 * @param {{
 *   dispatch_id?: string | null;
 *   outbox_status?: string | null;
 *   provider_message_id?: string | null;
 *   metadata?: Record<string, unknown> | null;
 * } | null | undefined} row
 */
export function isFaleConoscoDeliveryConfirmed(row) {
  if (!row?.dispatch_id) return false;
  if (row.outbox_status !== "sent") return false;

  const meta =
    row.metadata && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : {};

  if (meta.simulated === true) return false;

  const provider = meta.provider != null ? String(meta.provider) : "";
  if (provider === "mock" || provider === "sandbox_mock") return false;

  const messageId = row.provider_message_id != null ? String(row.provider_message_id).trim() : "";
  if (!messageId) return false;

  return true;
}

/**
 * @param {{
 *   ok?: boolean;
 *   dispatch_id?: string | null;
 *   outbox_status?: string | null;
 *   provider_message_id?: string | null;
 *   metadata?: Record<string, unknown> | null;
 *   last_error?: string | null;
 *   error?: string | null;
 *   delivery_mode?: string | null;
 * }} leg
 */
export function evaluateFaleConoscoLegOutcome(leg) {
  if (leg.ok !== true) {
    return {
      delivered: false,
      reason: leg.error ?? "PUBLISH_OR_PIPELINE_FAILED",
      delivery_mode: leg.delivery_mode ?? null,
    };
  }
  if (isFaleConoscoDeliveryConfirmed(leg)) {
    return {
      delivered: true,
      reason: "LIVE_SENT",
      delivery_mode: leg.delivery_mode ?? "resend",
    };
  }

  const mode = leg.delivery_mode ?? "unknown";
  let reason = "DELIVERY_NOT_CONFIRMED";
  const lastError = leg.last_error != null ? String(leg.last_error) : "";

  if (lastError === "EMAIL_PROVIDER_NOT_CONFIGURED" || !canSendFaleConoscoEmailLive()) {
    reason = "EMAIL_PROVIDER_NOT_CONFIGURED";
  } else if (leg.outbox_status === "pending" && lastError === "NOT_WHITELISTED") {
    reason = "BLOCKED_NOT_WHITELISTED";
  } else if (leg.metadata?.simulated === true || mode === "mock") {
    reason = "MOCK_SIMULATED";
  } else if (leg.outbox_status === "failed") {
    reason = lastError || "OUTBOX_FAILED";
  } else if (!leg.dispatch_id) {
    reason = leg.error ?? "DISPATCH_NOT_CREATED";
  } else if (leg.ok !== true) {
    reason = leg.error ?? "PUBLISH_OR_PIPELINE_FAILED";
  }

  return { delivered: false, reason, delivery_mode: mode };
}
