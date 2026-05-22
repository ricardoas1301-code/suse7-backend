// =============================================================================
// Provider de envio — mock / Resend / SendGrid via env (sem hardcode de API key)
// =============================================================================

import { config } from "../../../../infra/config.js";
import {
  evaluateEmailSendPolicy,
  getEmailSandboxWhitelist,
  isDevSandboxEmailMode,
  isEmailSandboxWhitelisted,
} from "./emailSandboxPolicy.js";
import { logEmailNotification } from "./emailLog.js";

/**
 * @typedef {Object} S7EmailSendInput
 * @property {string} to
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * @typedef {Object} S7EmailSendResult
 * @property {boolean} ok
 * @property {boolean} [simulated]
 * @property {string} [provider]
 * @property {string} [providerMessageId]
 * @property {string} [error]
 * @property {Record<string, unknown>} [raw]
 */

/**
 * @returns {boolean}
 */
export function isRealEmailProviderConfigured() {
  const mode = String(config.s7EmailMode ?? "").toLowerCase();
  if (mode === "mock" || mode === "simulate") return false;

  const provider = String(config.s7EmailProvider ?? "").toLowerCase();
  if (provider === "resend" && config.resendApiKey) return true;
  if (provider === "sendgrid" && config.sendgridApiKey) return true;
  return false;
}

/**
 * Envio real permitido (Resend/SendGrid) — inclui dev_sandbox com API key.
 * @returns {boolean}
 */
export function canSendRealEmailNow() {
  if (!isRealEmailProviderConfigured() && !isDevSandboxEmailMode()) return false;
  if (isDevSandboxEmailMode()) {
    const provider = String(config.s7EmailProvider ?? "").toLowerCase();
    if (provider === "resend" && config.resendApiKey) return true;
    if (provider === "sendgrid" && config.sendgridApiKey) return true;
    return false;
  }
  return isRealEmailProviderConfigured();
}

/**
 * @param {S7EmailSendInput} input
 * @returns {Promise<S7EmailSendResult>}
 */
export async function sendS7Email(input) {
  const to = String(input.to ?? "").trim().toLowerCase();
  if (!to || !to.includes("@")) {
    return { ok: false, error: "INVALID_EMAIL" };
  }

  const policy = evaluateEmailSendPolicy(to);
  if (!policy.allowed) {
    logEmailNotification("BLOCKED", {
      reason: policy.reason ?? "NOT_WHITELISTED",
      to_masked: maskEmailForLog(to),
      mode: policy.mode,
    });
    return { ok: false, error: policy.reason ?? "NOT_WHITELISTED", blocked: true };
  }

  const whitelistActive = getEmailSandboxWhitelist().length > 0;
  const maySendReal =
    canSendRealEmailNow() && (!whitelistActive || isEmailSandboxWhitelisted(to));

  if (maySendReal) {
    const provider = String(config.s7EmailProvider ?? "").toLowerCase();
    if (provider === "resend") return sendViaResend(input, to);
    if (provider === "sendgrid") {
      return { ok: false, error: "SENDGRID_NOT_IMPLEMENTED", provider: "sendgrid" };
    }
  }

  if (!isRealEmailProviderConfigured() && !isDevSandboxEmailMode()) {
    const mockId = `s7_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    logEmailNotification("SENT", {
      simulated: true,
      provider: "mock",
      provider_message_id: mockId,
      subject_preview: String(input.subject ?? "").slice(0, 80),
    });
    return {
      ok: true,
      simulated: true,
      provider: "mock",
      providerMessageId: mockId,
      raw: { mock: true },
    };
  }

  if (isDevSandboxEmailMode()) {
    const mockId = `s7_sandbox_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    logEmailNotification("SENT", {
      simulated: true,
      provider: "sandbox_mock",
      provider_message_id: mockId,
      subject_preview: String(input.subject ?? "").slice(0, 80),
      whitelist_only: true,
    });
    return {
      ok: true,
      simulated: true,
      provider: "sandbox_mock",
      providerMessageId: mockId,
      raw: { sandbox: true, whitelist: true },
    };
  }

  return { ok: false, error: "UNKNOWN_PROVIDER" };
}

/**
 * @param {string} email
 */
function maskEmailForLog(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return "***";
  const visible = user.length <= 2 ? "*" : `${user.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}

/**
 * @param {S7EmailSendInput} input
 * @param {string} to
 * @returns {Promise<S7EmailSendResult>}
 */
async function sendViaResend(input, to) {
  const apiKey = config.resendApiKey;
  if (!apiKey) return { ok: false, error: "RESEND_NOT_CONFIGURED" };

  const from = config.s7EmailFrom || "Suse7 <notificacoes@suse7.com.br>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = String(json?.message ?? json?.error ?? res.statusText ?? "resend_failed").slice(0, 500);
    logEmailNotification("FAILED", { provider: "resend", status: res.status, error: errMsg });
    return { ok: false, error: errMsg, provider: "resend", raw: { status: res.status } };
  }

  const messageId = json?.id != null ? String(json.id) : null;
  logEmailNotification("SENT", { provider: "resend", provider_message_id: messageId });
  return {
    ok: true,
    provider: "resend",
    providerMessageId: messageId,
    raw: { id: messageId },
  };
}
