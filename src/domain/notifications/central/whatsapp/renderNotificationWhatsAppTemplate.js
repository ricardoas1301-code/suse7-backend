// =============================================================================
// Template texto WhatsApp — motor central (Fase 3.5A)
// =============================================================================

import { config } from "../../../../infra/config.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";

const MAX_WHATSAPP_CHARS = 4096;

/**
 * @param {string} category
 * @param {string} type
 */
function severityEmoji(category, type) {
  const t = String(type).toUpperCase();
  if (["PAYMENT_FAILED", "SUSPENDED", "MARKETPLACE_DISCONNECTED", "SYNC_FAILED"].includes(t)) {
    return "🚨";
  }
  if (["ENTERED_GRACE", "NEGATIVE_MARGIN", "LOW_STOCK"].includes(t)) {
    return "⚠️";
  }
  if (category === "BILLING" && t === "PAYMENT_CONFIRMED") return "✅";
  return "📣";
}

/**
 * @param {{
 *   subject?: string;
 *   title?: string;
 *   message?: string;
 *   category?: string;
 *   type?: string;
 *   deepLink?: string | null;
 *   payload?: Record<string, unknown>;
 *   entityType?: string | null;
 *   entityId?: string | null;
 * }} input
 */
export function renderNotificationWhatsAppTemplate(input) {
  const category = String(input.category ?? "").trim();
  const type = String(input.type ?? "").trim();
  const title = String(input.title ?? input.subject ?? "Notificação Suse7").trim();
  const message = String(input.message ?? "").trim();

  const deepLink =
    input.deepLink != null && String(input.deepLink).trim() !== ""
      ? String(input.deepLink).trim()
      : resolveInAppDeepLink({
          category,
          type,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          payload: input.payload ?? {},
        });

  const baseUrl = (config.frontendUrl || "https://suse7.com.br").replace(/\/+$/, "");
  const ctaHref = deepLink.startsWith("http")
    ? deepLink
    : `${baseUrl}${deepLink.startsWith("/") ? deepLink : `/${deepLink}`}`;

  const emoji = severityEmoji(category, type);
  const lines = [`${emoji} Suse7 — ${title}`, ""];

  if (message) lines.push(message);

  if (ctaHref) {
    lines.push("", "Ver detalhes:", ctaHref);
  }

  let messageText = lines.join("\n").trim();
  if (messageText.length > MAX_WHATSAPP_CHARS) {
    messageText = `${messageText.slice(0, MAX_WHATSAPP_CHARS - 3)}...`;
  }

  return {
    message_text: messageText,
    deep_link: deepLink,
    cta_href: ctaHref,
  };
}
