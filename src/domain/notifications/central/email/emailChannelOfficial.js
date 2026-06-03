// =============================================================================
// S7 — Canal E-mail Oficial (Fase S5.5)
// Fonte única de metadados do canal e-mail do Motor Central.
//
// NÃO duplica envio: delega para S7EmailProvider + EmailNotificationProvider + outbox.
// NÃO altera "Fale Conosco" (Edge Function Supabase externa ao backend).
// =============================================================================

import { config } from "../../../../infra/config.js";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { getChannelDefinition } from "../channels/channelRegistry.js";
import {
  S7_EMAIL_DELIVERABILITY_DNS_HINTS,
  S7_EMAIL_OFFICIAL_DEFAULT_FROM,
  S7_EMAIL_OFFICIAL_MODE,
  S7_EMAIL_OFFICIAL_PROVIDER,
  S7_EMAIL_OFFICIAL_SENDING_DOMAIN,
  S7_EMAIL_OUTBOX_WORKER_PATH,
} from "./emailChannelContract.js";
import {
  canSendRealEmailNow,
  isRealEmailProviderConfigured,
} from "./S7EmailProvider.js";
import {
  evaluateEmailSendPolicy,
  getEmailSandboxWhitelist,
  isDevSandboxEmailMode,
} from "./emailSandboxPolicy.js";
import { S7_EMAIL_OUTBOX_STATUS } from "./emailOutboxStatus.js";

/**
 * Extrai domínio do endereço "Nome <email@dominio>" ou "email@dominio".
 * @param {string} from
 */
export function parseEmailFromDomain(from) {
  const raw = String(from ?? "").trim();
  const match = raw.match(/<([^>]+)>/);
  const addr = (match ? match[1] : raw).trim().toLowerCase();
  const domain = addr.split("@")[1];
  return domain ?? null;
}

/**
 * Snapshot oficial do canal (sem secrets).
 */
export function getOfficialEmailChannelSnapshot() {
  const channelDef = getChannelDefinition(S7_NOTIFICATION_CHANNEL.EMAIL);
  const provider = String(config.s7EmailProvider ?? S7_EMAIL_OFFICIAL_PROVIDER.MOCK).toLowerCase();
  const mode = String(config.s7EmailMode ?? S7_EMAIL_OFFICIAL_MODE.MOCK).toLowerCase();
  const from = String(config.s7EmailFrom ?? S7_EMAIL_OFFICIAL_DEFAULT_FROM).trim();
  const fromDomain = parseEmailFromDomain(from) ?? S7_EMAIL_OFFICIAL_SENDING_DOMAIN;

  return {
    channel_code: S7_NOTIFICATION_CHANNEL.EMAIL,
    channel_registry: channelDef
      ? {
          name: channelDef.name,
          status: channelDef.status,
          available: channelDef.available,
          delivery_mode: channelDef.delivery_mode,
        }
      : null,
    provider,
    mode,
    from_address: from,
    from_domain: fromDomain,
    official_sending_domain: S7_EMAIL_OFFICIAL_SENDING_DOMAIN,
    domain_aligned: fromDomain === S7_EMAIL_OFFICIAL_SENDING_DOMAIN,
    resend_configured: provider === S7_EMAIL_OFFICIAL_PROVIDER.RESEND && Boolean(config.resendApiKey),
    sendgrid_configured:
      provider === S7_EMAIL_OFFICIAL_PROVIDER.SENDGRID && Boolean(config.sendgridApiKey),
    can_send_real: canSendRealEmailNow(),
    is_real_provider_configured: isRealEmailProviderConfigured(),
    dev_sandbox: isDevSandboxEmailMode(),
    sandbox_whitelist_count: getEmailSandboxWhitelist().length,
    deliverability_dns_hints: S7_EMAIL_DELIVERABILITY_DNS_HINTS,
    outbox_worker_path: S7_EMAIL_OUTBOX_WORKER_PATH,
    outbox_statuses: Object.values(S7_EMAIL_OUTBOX_STATUS),
    dispatcher_integration: {
      provider_class: "EmailNotificationProvider",
      queue_table: "s7_notification_email_outbox",
      delivery_logs_table: "s7_notification_delivery_logs",
      dispatch_table: "s7_notification_dispatches",
    },
    fale_conosco: {
      integrated: false,
      note: "Fluxo legado via Supabase Edge Function send-contact-email (frontend). Não passa pelo Motor Central nesta fase.",
    },
  };
}

/**
 * Avalia política de envio para um destinatário (wrapper público).
 * @param {string} to
 */
export function evaluateOfficialEmailPolicy(to) {
  return evaluateEmailSendPolicy(to);
}
